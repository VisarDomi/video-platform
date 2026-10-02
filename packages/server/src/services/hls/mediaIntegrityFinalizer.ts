import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { nativeMediaRuns, parseNativeMediaPlaylist, renderNativeMediaRun, moveToDesktopTrash,
    type NativeMediaSegment } from "shared";

import { FILE_NAMES, HLS, MISC } from "../../core/constants.js";
import { FINALIZATION_DB_PATH, getProviderPaths } from "../../core/config.js";
import logger from "../../core/logger.js";
import { FinalizationCheckpointStore, playlistFingerprint } from "./finalizationCheckpointStore.js";
import { processFinalizedRecording } from "./finalizedRecordingProcessor.js";
import { PendingDirectoryObserver } from "./pendingDirectoryObserver.js";
import { inspectFmp4Fragment } from "./fragmentStructure.js";
import { pendingRoot, publishPendingRecording } from "./pendingRecordingPublisher.js";

const CATCH_UP_INTERVAL_MS = 60 * 60_000;
const QUEUE_COOLDOWN_MS = 15_000;
// Expose one validation lane per cgroup-aware available CPU so the systemd
// slice has enough runnable work to use its quota. On the current host Node
// reports 6 here for CPUQuota=600%; systemd remains the CPU authority.
const QUEUE_WORKER_COUNT = os.availableParallelism();
const DEEP_SCAN_CHECKPOINT_INTERVAL = 25;
const MAX_CAPTURED_STDERR_BYTES = 16_384;
const SUPPORTED_PROVIDERS = ["tango", "fc2", "sc"];
const IGNORED_NULL_MUXER_ERROR = "Application provided invalid, non monotonically increasing dts to muxer";
export const MEDIA_INTEGRITY_VALIDATOR_REVISION = 3;

interface PlaylistEntry extends NativeMediaSegment {
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
    status: "processing" | "ready" | "failed" | "empty";
    startedAt: string;
    completedAt: string | null;
    playlistPath: string;
    segmentCount: number;
    initialPlaylistValid: boolean | null;
    initialValidationError: string | null;
    deepScannedSegmentCount: number;
    invalidSegments: InvalidSegment[];
    detectedInvalidSegments?: InvalidSegment[];
    nativeRunResults?: NativeRunValidation[];
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
    inspectFragment?: (inputPath: string) => Promise<string | null>;
}

function parseMediaPlaylist(content: string): ParsedMediaPlaylist {
    const parsed = parseNativeMediaPlaylist(content);
    const entries = nativeMediaRuns(parsed.segments).flatMap((run, continuityEpoch) =>
        run.map(entry => ({ ...entry, continuityEpoch })));
    return { entries, hasMap: entries.some(entry => entry.mapUri !== null) };
}

export interface NativeRunValidation {
    firstIndex: number;
    lastIndex: number;
    valid: boolean;
    error: string | null;
    structuralFailures?: InvalidSegment[];
}

// Reset BOTH demuxer and decoder at native cuts. Concatenating unlike codecs
// or track layouts into one decoder is not a media-integrity check.
export async function validateNativeMediaPlaylist(streamPath: string, content: string,
    validateMedia: (inputPath: string) => Promise<MediaValidationResult> = validateMediaWithFfmpeg,
    options: { originalPath?: string; previous?: readonly NativeRunValidation[];
        checkpoint?: (results: NativeRunValidation[]) => void;
        inspectFragment?: (inputPath: string) => Promise<string | null> } = {},
): Promise<{ valid: boolean; results: NativeRunValidation[]; error: string | null }> {
    const runs = nativeMediaRuns(parseNativeMediaPlaylist(content).segments);
    if (!runs.length) return { valid: true, results: [], error: null };
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "video-native-integrity-"));
    const results: NativeRunValidation[] = [];
    try {
        for (const [index, run] of runs.entries()) {
            const firstIndex = run[0].index, lastIndex = run.at(-1)!.index;
            const prior = options.previous?.find(item => item.firstIndex === firstIndex && item.lastIndex === lastIndex);
            if (prior) results.push(prior);
            else {
                // An unavailable initialization is a recording-level blocker,
                // never evidence that every fragment referencing it is bad.
                if (run[0].mapUri) {
                    const initialization = await fs.open(path.join(streamPath, run[0].mapUri), "r");
                    try {
                        const stats = await initialization.stat();
                        if (!stats.isFile() || stats.size === 0) {
                            throw new Error(`Unavailable fMP4 initialization: ${run[0].mapUri}`);
                        }
                    } finally { await initialization.close(); }
                }
                const structuralFailures: InvalidSegment[] = [];
                for (const entry of run) {
                    if (entry.mapUri) {
                        const error = await (options.inspectFragment ?? inspectFmp4Fragment)(path.join(streamPath, entry.name));
                        if (error) structuralFailures.push({ name: entry.name, error });
                    }
                }
                const input = runs.length === 1 && options.originalPath
                    ? options.originalPath : path.join(temporary, `native-run-${index}.m3u8`);
                if (input !== options.originalPath) await fs.writeFile(input, renderNativeMediaRun(run, streamPath), "utf8");
                const result = await validateMedia(input);
                results.push({ firstIndex, lastIndex, valid: result.valid && !structuralFailures.length,
                    structuralFailures,
                    error: structuralFailures.length ? structuralFailures.map(item => `${item.name}: ${item.error}`).join("\n")
                        : result.valid ? null : summarizeValidationFailure(result) });
            }
            options.checkpoint?.([...results]);
        }
        return { valid: results.every(result => result.valid), results,
            error: results.filter(result => !result.valid).map(result =>
                `native run ${result.firstIndex}-${result.lastIndex}: ${result.error}`).join("\n") || null };
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
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

async function writeFmp4ValidationWindow(
    playlistPath: string,
    streamPath: string,
    entries: readonly PlaylistEntry[],
): Promise<void> {
    if (entries.length === 0) throw new Error("Cannot validate an empty fMP4 window");
    await fs.writeFile(playlistPath, renderNativeMediaRun(entries, streamPath), MISC.ENCODING_UTF8);
}

async function attributeInvalidFmp4Fragments(
    streamPath: string,
    entries: readonly PlaylistEntry[],
    validateMedia: (inputPath: string) => Promise<MediaValidationResult>,
    initialScanCount: number,
    initialFailures: ReadonlyMap<string, InvalidSegment>,
    checkpoint: (scanCount: number, failures: readonly InvalidSegment[]) => void,
    nativeResults: readonly NativeRunValidation[] = [],
): Promise<{ scanCount: number; invalidSegments: InvalidSegment[]; detected: InvalidSegment[]; isolatedFailureCount: number }> {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "video-fmp4-integrity-"));
    const windowPath = path.join(temporaryRoot, "window.m3u8");
    const failedSingles = new Map(initialFailures);
    let scanCount = Math.min(initialScanCount, entries.length);

    try {
        while (scanCount < entries.length) {
            const entry = entries[scanCount];
            if (failedSingles.has(entry.name)) {
                scanCount++;
                checkpoint(scanCount, [...failedSingles.values()]);
                continue;
            }
            if (nativeResults.some(run => run.valid && entry.index >= run.firstIndex && entry.index <= run.lastIndex)) {
                scanCount++;
                checkpoint(scanCount, [...failedSingles.values()]);
                continue;
            }
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

            const group = [entry];
            while (index + 1 < entries.length && entries[index + 1].continuityEpoch === entry.continuityEpoch
                && failedSingles.has(entries[index + 1].name)) group.push(entries[++index]);
            // An unavailable/unsupported initialization is not evidence that
            // all its media is damaged. Preserve diagnostics and block safely.
            if (group.some(item => isValidationEnvironmentFailure(failedSingles.get(item.name)!.error))) continue;
            const previous = entries[index - group.length];
            const next = entries[index + 1];
            const neighbors = [previous, next].filter((neighbor): neighbor is PlaylistEntry => (
                neighbor !== undefined && neighbor.continuityEpoch === entry.continuityEpoch
            ));
            let everyContextFails = true;
            for (const neighbor of group.every(item => failedSingles.get(item.name)!.error.startsWith("invalid fMP4 fragment structure"))
                ? [] : neighbors) {
                const pair = neighbor === previous ? [neighbor, ...group] : [...group, neighbor];
                await writeFmp4ValidationWindow(windowPath, streamPath, pair);
                if ((await validateMedia(windowPath)).valid) {
                    everyContextFails = false;
                    break;
                }
            }
            // A one-fragment epoch has no same-epoch neighbor. Its native run
            // already failed; the WHOLE retained candidate is verified before
            // committing any deletion. No percentage-based discard limit.
            if (everyContextFails) attributable.push(...group.map(item => failedSingles.get(item.name)!));
        }

        return {
            scanCount,
            invalidSegments: attributable,
            detected: [...failedSingles.values()],
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

function isValidationEnvironmentFailure(error: string): boolean {
    return /initialization|moov atom|permission denied|input\/output error|no space left|unknown decoder|unsupported codec|decoder.*not found|no decoder found/i.test(error);
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
        detectedInvalidSegments: resumableReport?.detectedInvalidSegments ?? resumableReport?.invalidSegments ?? [],
        nativeRunResults: resumableReport?.nativeRunResults ?? [],
        error: null,
    };
    options.checkpointStore?.write(streamPath, fingerprint, processingReport);

    try {
        const initialValidation = processingReport.initialPlaylistValid === null
            ? await validateNativeMediaPlaylist(streamPath, originalPlaylist, validateMedia, {
                originalPath: playlistPath,
                previous: processingReport.nativeRunResults,
                inspectFragment: options.inspectFragment,
                checkpoint: results => {
                    processingReport.nativeRunResults = results;
                    options.checkpointStore?.write(streamPath, fingerprint, processingReport);
                },
            })
            : null;
        const initialPlaylistValid = processingReport.initialPlaylistValid ?? initialValidation?.valid ?? false;
        const initialValidationError = processingReport.initialValidationError ?? (
            initialValidation && !initialValidation.valid
                ? initialValidation.error
                : null
        );
        const invalidByName = new Map(
            (processingReport.detectedInvalidSegments ?? processingReport.invalidSegments).map((segment) => [segment.name, segment]),
        );
        for (const run of processingReport.nativeRunResults ?? []) {
            for (const failure of run.structuralFailures ?? []) invalidByName.set(failure.name, failure);
        }
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
                const validatedRun = processingReport.nativeRunResults?.some(run => run.valid
                    && entry.index >= run.firstIndex && entry.index <= run.lastIndex);
                const result = validatedRun ? null : await validateMedia(path.join(streamPath, entry.name));
                deepScannedSegmentCount++;
                if (result && !result.valid) {
                    const error = summarizeValidationFailure(result);
                    if (isValidationEnvironmentFailure(error)) {
                        throw new Error(`Native validation blocked without attributing media damage: ${error}`);
                    }
                    invalidByName.set(entry.name, { name: entry.name, error });
                }

                if (
                    deepScannedSegmentCount % DEEP_SCAN_CHECKPOINT_INTERVAL === 0 ||
                    deepScannedSegmentCount === parsed.entries.length
                ) {
                    processingReport.deepScannedSegmentCount = deepScannedSegmentCount;
                    processingReport.invalidSegments = [...invalidByName.values()];
                    processingReport.detectedInvalidSegments = [...invalidByName.values()];
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
                    processingReport.detectedInvalidSegments = [...failures];
                    if (scanCount % DEEP_SCAN_CHECKPOINT_INTERVAL === 0 || scanCount === parsed.entries.length) {
                        options.checkpointStore?.write(streamPath, fingerprint, processingReport);
                    }
                },
                processingReport.nativeRunResults,
            );
            deepScannedSegmentCount = attribution.scanCount;
            isolatedFmp4FailureCount = attribution.isolatedFailureCount;
            processingReport.detectedInvalidSegments = attribution.detected;
            invalidByName.clear();
            for (const segment of attribution.invalidSegments) invalidByName.set(segment.name, segment);
        }

        const invalidSegments = [...invalidByName.values()];
        const error = initialPlaylistValid
            ? null
            : parsed.hasMap
                ? invalidSegments.length > 0
                    ? `strict playlist validation failed; ${invalidSegments.length} ${invalidSegments.length === 1 ? "isolated " : ""}fMP4 fragments failed contextual validation; retained candidate requires verification`
                    : `strict playlist validation failed; ${isolatedFmp4FailureCount} fMP4 fragments failed individual validation but no safe isolated repair boundary was established: ${initialValidationError ?? "unknown ffmpeg error"}`
                : `strict playlist validation failed; ${invalidSegments.length} of ${parsed.entries.length} MPEG-TS segments failed individual validation`;
        const report: MediaIntegrityReport = {
            ...processingReport,
            status: parsed.entries.length === 0 ? "empty" : initialPlaylistValid ? "ready" : "failed",
            completedAt: now().toISOString(),
            initialPlaylistValid,
            initialValidationError,
            deepScannedSegmentCount,
            invalidSegments,
            error: parsed.entries.length === 0 ? "empty capture: no retained media segments" : error,
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
    // The handoff mailboxes are permanent infrastructure: create them eagerly
    // so the direct non-recursive watches always have a live target.
    for (const rootPath of roots) {
        void fs.mkdir(rootPath, { recursive: true }).catch(() => {});
    }
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
        if (result.report.status === "empty") {
            // Empty/all-bad captures have an explicit terminal disposition,
            // not an endlessly retried .pending directory. Recoverable only.
            await moveToDesktopTrash(streamPath);
            logger.info("[Finalization] empty capture moved to desktop Trash", { streamPath,
                discardedSegmentCount: result.report.detectedInvalidSegments?.length ?? 0 });
            return;
        }
        if (result.report.status !== "ready") {
            logger.error("[Finalization] pending recording remains unpublished", {
                streamPath,
                error: result.report.error,
                invalidSegmentCount: result.report.invalidSegments.length,
            });
            return;
        }
        const finalizedPath = await publishPendingRecording(streamPath);
        checkpointStore.write(finalizedPath,
            playlistFingerprint(await fs.readFile(path.join(finalizedPath, FILE_NAMES.HLS_PLAYLIST), "utf8")),
            { ...result.report, playlistPath: path.join(finalizedPath, FILE_NAMES.HLS_PLAYLIST) });
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
