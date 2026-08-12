import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

import { FILE_NAMES, HLS, MISC } from "../../core/constants.js";
import { FINALIZATION_DB_PATH, getProviderPaths } from "../../core/config.js";
import logger from "../../core/logger.js";
import { FinalizationCheckpointStore, playlistFingerprint } from "./finalizationCheckpointStore.js";
import { processFinalizedRecording } from "./finalizedRecordingProcessor.js";
import { PendingDirectoryObserver } from "./pendingDirectoryObserver.js";
import { pendingRoot, publishPendingRecording } from "./pendingRecordingPublisher.js";

const CATCH_UP_INTERVAL_MS = 60 * 60_000;
const QUEUE_COOLDOWN_MS = 15_000;
const QUEUE_WORKER_COUNT = Math.max(1, Math.floor(os.cpus().length / 2));
const DEEP_SCAN_CHECKPOINT_INTERVAL = 25;
const FFMPEG_NICE_PRIORITY = 10;
const MAX_CAPTURED_STDERR_BYTES = 16_384;
const SUPPORTED_PROVIDERS = ["tango", "fc2", "sc"];
const IGNORED_NULL_MUXER_ERROR = "Application provided invalid, non monotonically increasing dts to muxer";

interface PlaylistEntry {
    name: string;
}

interface ParsedMediaPlaylist {
    entries: PlaylistEntry[];
    hasMap: boolean;
}

export interface MediaValidationResult {
    valid: boolean;
    exitCode: number | null;
    stderr: string;
}

export interface InvalidSegment {
    name: string;
    error: string;
}

export interface MediaIntegrityReport {
    version: 2;
    status: "processing" | "ready" | "failed";
    startedAt: string;
    completedAt: string | null;
    playlistPath: string;
    segmentCount: number;
    initialPlaylistValid: boolean | null;
    initialValidationError: string | null;
    deepScannedSegmentCount: number;
    invalidSegments: InvalidSegment[];
    error: string | null;
}

export type MediaIntegrityFinalizationResult =
    | { kind: "not-finalized" }
    | { kind: "already-processed"; report: MediaIntegrityReport }
    | { kind: "processed"; report: MediaIntegrityReport };

export interface MediaIntegrityFinalizerOptions {
    validateMedia?: (inputPath: string) => Promise<MediaValidationResult>;
    now?: () => Date;
    retryFailed?: boolean;
    revalidate?: boolean;
    checkpointStore?: FinalizationCheckpointStore;
}

function parseMediaPlaylist(content: string): ParsedMediaPlaylist {
    const entries: PlaylistEntry[] = [];
    let hasMap = false;

    for (const rawLine of content.split("\n")) {
        const line = rawLine.trim();
        if (line === "" || line === HLS.ENDLIST) continue;

        if (line.startsWith(HLS.MAP_PREFIX)) {
            hasMap = true;
        }

        if (!line.startsWith("#")) entries.push({ name: line });
    }

    return { entries, hasMap };
}

function isIgnoredMediaDecodeError(line: string): boolean {
    return line.includes(IGNORED_NULL_MUXER_ERROR);
}

export function mediaDecodeErrors(stderr: string): string {
    return stderr
        .split("\n")
        .filter((line) => !isIgnoredMediaDecodeError(line))
        .join("\n")
        .trim();
}

class FfmpegErrorCollector {
    private remainder = "";
    private captured = "";

    append(chunk: Buffer): void {
        const lines = (this.remainder + chunk.toString(MISC.ENCODING_UTF8)).split("\n");
        this.remainder = lines.pop() ?? "";
        for (const line of lines) this.capture(line);
    }

    finish(): string {
        if (this.remainder !== "") this.capture(this.remainder);
        return this.captured.trim();
    }

    private capture(line: string): void {
        if (isIgnoredMediaDecodeError(line) || this.captured.length >= MAX_CAPTURED_STDERR_BYTES) return;
        this.captured = `${this.captured}${line}\n`.slice(0, MAX_CAPTURED_STDERR_BYTES);
    }
}

export function collectMediaDecodeErrors(chunks: Buffer[]): string {
    const collector = new FfmpegErrorCollector();
    for (const chunk of chunks) collector.append(chunk);
    return collector.finish();
}

export function buildFfmpegValidationArgs(inputPath: string): string[] {
    return [
        "-nostdin",
        "-hide_banner",
        "-v", "error",
        "-filter_threads", "1",
        "-filter_complex_threads", "1",
        "-threads", "1",
        "-i", inputPath,
        "-map", "0:v?",
        "-map", "0:a?",
        "-f", "null",
        "-",
    ];
}

export function validateMediaWithFfmpeg(inputPath: string): Promise<MediaValidationResult> {
    return new Promise((resolve, reject) => {
        const child = spawn("ffmpeg", buildFfmpegValidationArgs(inputPath), {
            stdio: ["ignore", "ignore", "pipe"],
        });

        if (child.pid !== undefined) {
            try {
                os.setPriority(child.pid, FFMPEG_NICE_PRIORITY);
            } catch {}
        }

        const errors = new FfmpegErrorCollector();
        let spawnError: Error | null = null;
        child.stderr.on("data", (chunk: Buffer) => {
            errors.append(chunk);
        });
        child.on("error", (error) => {
            spawnError = error;
        });
        child.on("close", (exitCode) => {
            if (spawnError) {
                reject(spawnError);
                return;
            }
            const normalizedStderr = errors.finish();
            resolve({
                valid: normalizedStderr === "" && exitCode === 0,
                exitCode,
                stderr: normalizedStderr,
            });
        });
    });
}

function summarizeValidationFailure(result: MediaValidationResult): string {
    if (result.stderr !== "") return result.stderr;
    return `ffmpeg exited with code ${result.exitCode ?? "unknown"}`;
}

function isSafeTsSegmentName(name: string): boolean {
    return path.basename(name) === name && name.endsWith(".ts");
}

export async function finalizeMediaIntegrity(
    streamPath: string,
    options: MediaIntegrityFinalizerOptions = {},
): Promise<MediaIntegrityFinalizationResult> {
    const validateMedia = options.validateMedia ?? validateMediaWithFfmpeg;
    const now = options.now ?? (() => new Date());
    const playlistPath = path.join(streamPath, FILE_NAMES.HLS_PLAYLIST);
    const originalPlaylist = await fs.readFile(playlistPath, MISC.ENCODING_UTF8);

    if (!originalPlaylist.split(/\r?\n/).some((line) => line.trim() === HLS.ENDLIST)) {
        return { kind: "not-finalized" };
    }

    const fingerprint = playlistFingerprint(originalPlaylist);
    const existingReport = options.checkpointStore?.read<MediaIntegrityReport>(streamPath, fingerprint) ?? null;
    if (
        (existingReport?.status === "ready" && options.revalidate !== true) ||
        (existingReport?.status === "failed" && options.retryFailed !== true)
    ) {
        return { kind: "already-processed", report: existingReport };
    }

    const parsed = parseMediaPlaylist(originalPlaylist);
    const resumableReport = existingReport?.version === 2 && existingReport.status === "processing"
        ? existingReport
        : null;
    const processingReport: MediaIntegrityReport = {
        version: 2,
        status: "processing",
        startedAt: resumableReport?.startedAt ?? now().toISOString(),
        completedAt: null,
        playlistPath,
        segmentCount: parsed.entries.length,
        initialPlaylistValid: resumableReport?.initialPlaylistValid ?? null,
        initialValidationError: resumableReport?.initialValidationError ?? null,
        deepScannedSegmentCount: resumableReport?.deepScannedSegmentCount ?? 0,
        invalidSegments: resumableReport?.invalidSegments ?? [],
        error: null,
    };
    options.checkpointStore?.write(streamPath, fingerprint, processingReport);

    try {
        const initialValidation = processingReport.initialPlaylistValid === null
            ? await validateMedia(playlistPath)
            : null;
        const initialPlaylistValid = processingReport.initialPlaylistValid ?? initialValidation?.valid ?? false;
        const initialValidationError = processingReport.initialValidationError ?? (
            initialValidation && !initialValidation.valid
                ? summarizeValidationFailure(initialValidation)
                : null
        );
        const invalidByName = new Map(
            processingReport.invalidSegments.map((segment) => [segment.name, segment]),
        );
        let deepScannedSegmentCount = Math.min(processingReport.deepScannedSegmentCount, parsed.entries.length);

        processingReport.initialPlaylistValid = initialPlaylistValid;
        processingReport.initialValidationError = initialValidationError;
        options.checkpointStore?.write(streamPath, fingerprint, processingReport);

        if (!initialPlaylistValid && !parsed.hasMap) {
            for (let index = deepScannedSegmentCount; index < parsed.entries.length; index++) {
                const entry = parsed.entries[index];
                if (!isSafeTsSegmentName(entry.name)) {
                    throw new Error(`Unsafe or unsupported MPEG-TS segment name: ${entry.name}`);
                }
                const result = await validateMedia(path.join(streamPath, entry.name));
                deepScannedSegmentCount++;
                if (!result.valid) {
                    invalidByName.set(entry.name, {
                        name: entry.name,
                        error: summarizeValidationFailure(result),
                    });
                }

                if (
                    deepScannedSegmentCount % DEEP_SCAN_CHECKPOINT_INTERVAL === 0 ||
                    deepScannedSegmentCount === parsed.entries.length
                ) {
                    processingReport.deepScannedSegmentCount = deepScannedSegmentCount;
                    processingReport.invalidSegments = [...invalidByName.values()];
                    options.checkpointStore?.write(streamPath, fingerprint, processingReport);
                }
            }
        }

        const invalidSegments = [...invalidByName.values()];
        const error = initialPlaylistValid
            ? null
            : parsed.hasMap
                ? `strict playlist validation failed; fMP4 segment attribution is not supported: ${initialValidationError ?? "unknown ffmpeg error"}`
                : `strict playlist validation failed; ${invalidSegments.length} of ${parsed.entries.length} MPEG-TS segments failed individual validation`;
        const report: MediaIntegrityReport = {
            ...processingReport,
            status: initialPlaylistValid ? "ready" : "failed",
            completedAt: now().toISOString(),
            initialPlaylistValid,
            initialValidationError,
            deepScannedSegmentCount,
            invalidSegments,
            error,
        };
        options.checkpointStore?.write(streamPath, fingerprint, report);
        logger.info("[MediaIntegrity] validation finished", {
            streamPath,
            status: report.status,
            segmentCount: report.segmentCount,
            invalidSegmentCount: report.invalidSegments.length,
            deepScannedSegmentCount: report.deepScannedSegmentCount,
        });
        return { kind: "processed", report };
    } catch (error: any) {
        const failedReport: MediaIntegrityReport = {
            ...processingReport,
            status: "failed",
            completedAt: now().toISOString(),
            error: error?.message ?? String(error),
        };
        options.checkpointStore?.write(streamPath, fingerprint, failedReport);
        logger.error("[MediaIntegrity] stream finalization failed", {
            streamPath,
            error: failedReport.error,
        });
        return { kind: "processed", report: failedReport };
    }
}

async function isPendingCandidate(streamPath: string): Promise<boolean> {
    try {
        const content = await fs.readFile(path.join(streamPath, FILE_NAMES.HLS_PLAYLIST), MISC.ENCODING_UTF8);
        return content.split(/\r?\n/).some((line) => line.trim() === HLS.ENDLIST);
    } catch {
        return false;
    }
}

function pendingRoots(): string[] {
    return SUPPORTED_PROVIDERS.flatMap((provider) => {
        const paths = getProviderPaths(provider);
        return [pendingRoot(paths.downloader), pendingRoot(paths.edited)];
    });
}

function isOwnedPendingPath(streamPath: string, roots: readonly string[]): boolean {
    const parent = path.dirname(path.resolve(streamPath));
    return roots.some((rootPath) => parent === path.resolve(rootPath));
}

export class MediaIntegrityQueue {
    private readonly pendingPaths: string[] = [];
    private readonly knownPaths = new Set<string>();
    private readonly idleWaiters: Array<() => void> = [];
    private activeWorkerCount = 0;

    constructor(
        private readonly processPath: (streamPath: string) => Promise<void>,
        private readonly cooldownMs = QUEUE_COOLDOWN_MS,
        private readonly workerCount = QUEUE_WORKER_COUNT,
    ) {}

    get depth(): number {
        return this.knownPaths.size;
    }

    enqueue(streamPath: string): boolean {
        if (this.knownPaths.has(streamPath)) return false;
        this.knownPaths.add(streamPath);
        this.pendingPaths.push(streamPath);
        this.startWorkers();
        return true;
    }

    async onIdle(): Promise<void> {
        if (this.activeWorkerCount === 0 && this.pendingPaths.length === 0) return;
        await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }

    private startWorkers(): void {
        while (this.activeWorkerCount < this.workerCount && this.pendingPaths.length > 0) {
            this.activeWorkerCount++;
            void this.runWorker();
        }
    }

    private async runWorker(): Promise<void> {
        while (true) {
            const streamPath = this.pendingPaths.shift();
            if (streamPath === undefined) break;
            try {
                await this.processPath(streamPath);
            } catch (error: any) {
                logger.error("[MediaIntegrity] queued stream failed", {
                    streamPath,
                    error: error?.message,
                });
            } finally {
                this.knownPaths.delete(streamPath);
            }

            if (this.pendingPaths.length > 0 && this.cooldownMs > 0) {
                await new Promise<void>((resolve) => setTimeout(resolve, this.cooldownMs));
            }
        }

        this.activeWorkerCount--;
        this.startWorkers();
        if (this.activeWorkerCount === 0 && this.pendingPaths.length === 0) {
            for (const resolve of this.idleWaiters.splice(0)) resolve();
        }
    }
}

export function startMediaIntegrityFinalizer(): void {
    const roots = pendingRoots();
    const checkpointStore = new FinalizationCheckpointStore(FINALIZATION_DB_PATH);
    let catchUpRunning = false;
    const processingQueue = new MediaIntegrityQueue(async (streamPath) => {
        logger.info("[Finalization] queue started pending recording", {
            streamPath,
            queueDepth: processingQueue.depth,
        });
        const result = await processFinalizedRecording(streamPath, { checkpointStore });
        if (result.kind === "not-finalized") return;
        if (result.report.status !== "ready") {
            logger.error("[Finalization] pending recording remains unpublished", {
                streamPath,
                error: result.report.error,
                invalidSegmentCount: result.report.invalidSegments.length,
            });
            return;
        }
        const finalizedPath = await publishPendingRecording(streamPath);
        checkpointStore.clear(streamPath);
        logger.info("[Finalization] atomically published validated recording", {
            pendingPath: streamPath,
            finalizedPath,
            segmentCount: result.report.segmentCount,
        });
    });

    const enqueue = (streamPath: string) => {
        if (!isOwnedPendingPath(streamPath, roots)) return;
        if (processingQueue.enqueue(streamPath)) {
            logger.info("[Finalization] queued pending recording", {
                streamPath,
                queueDepth: processingQueue.depth,
            });
        }
    };

    const catchUp = async () => {
        if (catchUpRunning) return;
        catchUpRunning = true;
        try {
            for (const rootPath of roots) {
                let entries;
                try {
                    entries = await fs.readdir(rootPath, { withFileTypes: true });
                } catch {
                    continue;
                }
                for (const entry of entries) {
                    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
                    const streamPath = path.join(rootPath, entry.name);
                    if (await isPendingCandidate(streamPath)) enqueue(streamPath);
                }
            }
        } finally {
            catchUpRunning = false;
        }
    };

    void (async () => {
        await Promise.all(roots.map((rootPath) => fs.mkdir(rootPath, { recursive: true })));
        const observer = new PendingDirectoryObserver(
            roots,
            (streamPath) => {
                void isPendingCandidate(streamPath).then((pending) => {
                    if (pending) enqueue(streamPath);
                }).catch(() => {});
            },
            catchUp,
            (rootPath, error) => logger.error(
                "[Finalization] pending-root watch failed; hourly reconciliation remains active",
                { rootPath, error: error.message },
            ),
        );
        await observer.start();
        setInterval(() => void catchUp(), CATCH_UP_INTERVAL_MS);
        logger.info("[Finalization] watching downloader/server handoff roots", {
            completionSignal: HLS.ENDLIST,
            roots,
            workerCount: QUEUE_WORKER_COUNT,
            cooldownMs: QUEUE_COOLDOWN_MS,
        });
    })().catch((error: any) => {
        checkpointStore.close();
        logger.error("[Finalization] failed to start finalizer", { error: error?.message });
    });
}
