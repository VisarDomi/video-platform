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
// One lane per core (the canonical batch default — GNU parallel, ninja):
// parallelism the app must open itself. Actual CPU usage is governed by the
// systemd slice; the app neither throttles nor budgets anything.
const QUEUE_WORKER_COUNT = os.availableParallelism();
const DEEP_SCAN_CHECKPOINT_INTERVAL = 25;
const MAX_CAPTURED_STDERR_BYTES = 16_384;
const SUPPORTED_PROVIDERS = ["tango", "fc2", "sc"];
const IGNORED_NULL_MUXER_ERROR = "Application provided invalid, non monotonically increasing dts to muxer";
export const MEDIA_INTEGRITY_VALIDATOR_REVISION = 2;

interface PlaylistEntry {
    name: string;
    duration: number;
    mapLine: string | null;
    continuityEpoch: number;
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
    validatorRevision: number;
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
    let activeMapLine: string | null = null;
    let duration = 0;
    let continuityEpoch = 0;

    for (const rawLine of content.split("\n")) {
        const line = rawLine.trim();
        if (line === "" || line === HLS.ENDLIST) continue;

        if (line.startsWith(HLS.MAP_PREFIX)) {
            hasMap = true;
            if (activeMapLine !== null && activeMapLine !== line) continuityEpoch++;
            activeMapLine = line;
        }
        if (line === HLS.DISCONTINUITY) {
            continuityEpoch++;
        }
        if (line.startsWith(HLS.INF_PREFIX)) {
            const parsedDuration = Number.parseFloat(line.slice(HLS.INF_PREFIX.length).split(",")[0]);
            duration = Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : 0;
        }

        if (!line.startsWith("#")) {
            entries.push({ name: line, duration, mapLine: activeMapLine, continuityEpoch });
            duration = 0;
        }
    }

    return { entries, hasMap };
}

function isIgnoredMediaDecodeError(line: string): boolean {
    return line.includes(IGNORED_NULL_MUXER_ERROR);
}

function isRepeatedIgnoredError(line: string, previousLineWasIgnored: boolean): boolean {
    return previousLineWasIgnored && /^\s*Last message repeated \d+ times?\s*$/.test(line);
}

export function mediaDecodeErrors(stderr: string): string {
    const errors: string[] = [];
    let previousLineWasIgnored = false;
    for (const line of stderr.split("\n")) {
        if (isIgnoredMediaDecodeError(line)) {
            previousLineWasIgnored = true;
            continue;
        }
        if (isRepeatedIgnoredError(line, previousLineWasIgnored)) continue;
        previousLineWasIgnored = false;
        errors.push(line);
    }
    return errors.join("\n").trim();
}

class FfmpegErrorCollector {
    private remainder = "";
    private captured = "";
    private previousLineWasIgnored = false;

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
        if (isIgnoredMediaDecodeError(line)) {
            this.previousLineWasIgnored = true;
            return;
        }
        if (isRepeatedIgnoredError(line, this.previousLineWasIgnored)) return;
        this.previousLineWasIgnored = false;
        if (this.captured.length >= MAX_CAPTURED_STDERR_BYTES) return;
        this.captured = `${this.captured}${line}\n`.slice(0, MAX_CAPTURED_STDERR_BYTES);
    }
}

export function collectMediaDecodeErrors(chunks: Buffer[]): string {
    const collector = new FfmpegErrorCollector();
    for (const chunk of chunks) collector.append(chunk);
    return collector.finish();
}

// No thread/priority flags: ffmpeg picks its own defaults, and the
// systemd slice governs how much CPU the unit actually gets.
export function buildFfmpegValidationArgs(inputPath: string): string[] {
    return [
        "-nostdin",
        "-hide_banner",
        "-loglevel", "repeat+error",
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

function localPlaylistFileUri(filePath: string): string {
    const resolved = path.resolve(filePath);
    if (/[\r\n"]/.test(resolved)) {
        throw new Error(`Unsupported control character in fMP4 media path: ${resolved}`);
    }
    return `file://${resolved}`;
}

function localMapLine(streamPath: string, mapLine: string | null): string {
    if (mapLine === null) throw new Error("fMP4 fragment has no active EXT-X-MAP");
    const match = mapLine.match(/\bURI="([^"]+)"/);
    if (!match) throw new Error(`Unsupported EXT-X-MAP without a quoted URI: ${mapLine}`);
    const mapName = match[1];
    if (path.basename(mapName) !== mapName || /[|\r\n"]/.test(mapName)) {
        throw new Error(`Unsafe fMP4 initialization filename: ${mapName}`);
    }
    return mapLine.replace(match[1], localPlaylistFileUri(path.join(streamPath, mapName)));
}

function safeFmp4FragmentPath(streamPath: string, name: string): string {
    if (path.basename(name) !== name || /[|\r\n]/.test(name)) {
        throw new Error(`Unsafe fMP4 fragment filename: ${name}`);
    }
    return path.join(streamPath, name);
}

async function writeFmp4ValidationWindow(
    playlistPath: string,
    streamPath: string,
    entries: readonly PlaylistEntry[],
): Promise<void> {
    if (entries.length === 0) throw new Error("Cannot validate an empty fMP4 window");
    const mapLine = localMapLine(streamPath, entries[0].mapLine);
    if (entries.some((entry) => entry.mapLine !== entries[0].mapLine)) {
        throw new Error("An fMP4 validation window cannot span initialization epochs");
    }
    const targetDuration = Math.max(1, Math.ceil(Math.max(...entries.map((entry) => entry.duration))));
    const lines = [
        HLS.HEADER,
        "#EXT-X-VERSION:7",
        `${HLS.TARGET_DURATION_PREFIX}${targetDuration}`,
        "#EXT-X-MEDIA-SEQUENCE:0",
        mapLine,
    ];
    for (const entry of entries) {
        lines.push(
            `${HLS.INF_PREFIX}${entry.duration.toFixed(6)},`,
            localPlaylistFileUri(safeFmp4FragmentPath(streamPath, entry.name)),
        );
    }
    lines.push(HLS.ENDLIST, "");
    await fs.writeFile(playlistPath, lines.join(MISC.NEW_LINE), MISC.ENCODING_UTF8);
}

async function attributeInvalidFmp4Fragments(
    streamPath: string,
    entries: readonly PlaylistEntry[],
    validateMedia: (inputPath: string) => Promise<MediaValidationResult>,
    initialScanCount: number,
    initialFailures: ReadonlyMap<string, InvalidSegment>,
    checkpoint: (scanCount: number, failures: readonly InvalidSegment[]) => void,
): Promise<{ scanCount: number; invalidSegments: InvalidSegment[]; isolatedFailureCount: number }> {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "video-fmp4-integrity-"));
    const windowPath = path.join(temporaryRoot, "window.m3u8");
    const failedSingles = new Map(initialFailures);
    let scanCount = Math.min(initialScanCount, entries.length);

    try {
        while (scanCount < entries.length) {
            const entry = entries[scanCount];
            const singleWindowPath = path.join(temporaryRoot, "window-single.m3u8");
            await writeFmp4ValidationWindow(singleWindowPath, streamPath, [entry]);
            const result = await validateMedia(singleWindowPath);
            if (!result.valid) {
                failedSingles.set(entry.name, {
                    name: entry.name,
                    error: summarizeValidationFailure(result),
                });
            }
            scanCount++;
            checkpoint(scanCount, [...failedSingles.values()]);
        }

        const attributable: InvalidSegment[] = [];
        for (let index = 0; index < entries.length; index++) {
            const entry = entries[index];
            const failure = failedSingles.get(entry.name);
            if (!failure) continue;

            const previous = entries[index - 1];
            const next = entries[index + 1];
            const neighbors = [previous, next].filter((neighbor): neighbor is PlaylistEntry => (
                neighbor !== undefined && neighbor.continuityEpoch === entry.continuityEpoch
            ));
            if (neighbors.length === 0 || neighbors.some((neighbor) => failedSingles.has(neighbor.name))) {
                continue;
            }

            let everyContextFails = true;
            for (const neighbor of neighbors) {
                const pair = neighbor === previous ? [neighbor, entry] : [entry, neighbor];
                await writeFmp4ValidationWindow(windowPath, streamPath, pair);
                if ((await validateMedia(windowPath)).valid) {
                    everyContextFails = false;
                    break;
                }
            }
            if (everyContextFails) attributable.push(failure);
        }

        return {
            scanCount,
            invalidSegments: attributable,
            isolatedFailureCount: failedSingles.size,
        };
    } finally {
        await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
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
    const validateMedia = options.validateMedia
        ?? ((inputPath: string) => validateMediaWithFfmpeg(inputPath));
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
        (
            existingReport?.status === "failed"
            && existingReport.validatorRevision === MEDIA_INTEGRITY_VALIDATOR_REVISION
            && options.retryFailed !== true
        )
    ) {
        return { kind: "already-processed", report: existingReport };
    }

    const parsed = parseMediaPlaylist(originalPlaylist);
    const resumableReport = existingReport?.version === 2
        && existingReport.validatorRevision === MEDIA_INTEGRITY_VALIDATOR_REVISION
        && existingReport.status === "processing"
        ? existingReport
        : null;
    const processingReport: MediaIntegrityReport = {
        version: 2,
        validatorRevision: MEDIA_INTEGRITY_VALIDATOR_REVISION,
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
        let isolatedFmp4FailureCount = 0;

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
        } else if (!initialPlaylistValid && parsed.hasMap) {
            const attribution = await attributeInvalidFmp4Fragments(
                streamPath,
                parsed.entries,
                validateMedia,
                deepScannedSegmentCount,
                invalidByName,
                (scanCount, failures) => {
                    processingReport.deepScannedSegmentCount = scanCount;
                    processingReport.invalidSegments = [...failures];
                    options.checkpointStore?.write(streamPath, fingerprint, processingReport);
                },
            );
            deepScannedSegmentCount = attribution.scanCount;
            isolatedFmp4FailureCount = attribution.isolatedFailureCount;
            invalidByName.clear();
            for (const segment of attribution.invalidSegments) invalidByName.set(segment.name, segment);
        }

        const invalidSegments = [...invalidByName.values()];
        const error = initialPlaylistValid
            ? null
            : parsed.hasMap
                ? invalidSegments.length > 0
                    ? `strict playlist validation failed; ${invalidSegments.length} isolated fMP4 fragments failed contextual validation`
                    : `strict playlist validation failed; ${isolatedFmp4FailureCount} fMP4 fragments failed individual validation but no safe isolated repair boundary was established: ${initialValidationError ?? "unknown ffmpeg error"}`
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
    // .pending is capture-only: edited recordings publish directly (their
    // kept segments were already validated at capture), so only the
    // downloaded handoff roots flow through media validation.
    return SUPPORTED_PROVIDERS.flatMap((provider) => {
        const paths = getProviderPaths(provider);
        return [pendingRoot(paths.downloaded)];
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
        const result = await processFinalizedRecording(streamPath, {
            checkpointStore,
        });
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
        // Remove the handoff directory once it is empty; it is recreated on
        // demand by the producer (downloader handoff or the video editor).
        await fs.rmdir(path.dirname(streamPath)).catch(() => {});
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
