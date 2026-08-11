import { promises as fs } from "fs";
import path from "path";
import { spawn } from "child_process";
import pLimit from "p-limit";
import { selectLongestMediaDuration } from "shared";
import logger from "../../core/logger.js";
import { FILE_NAMES, HLS, MISC } from "../../core/constants.js";

export interface PlaylistRepairSummary {
    playlistPath: string;
    durationMode: "media-timeline";
    skipped: boolean;
    skipReason: string | null;
    segmentCount: number;
    probedCount: number;
    byteProbeCount: number;
    ffprobeProbeCount: number;
    failedProbeCount: number;
    changedDurationCount: number;
    missingSegmentCount: number;
    videoTimelineCount: number;
    streamDurationCount: number;
    totalDurationBefore: number;
    totalDurationAfter: number;
    totalDurationDelta: number;
    maxSegmentDelta: number;
    targetDurationBefore: number | null;
    targetDurationAfter: number;
    playlistChanged: boolean;
    wrotePlaylist: boolean;
    writeSkippedReason: "dry-run" | "write-guard" | null;
}

export interface PlaylistRepairOptions {
    apply?: boolean;
    probeConcurrency?: number;
    beforeProbe?: () => Promise<void>;
    beforeWrite?: () => Promise<boolean>;
}

export interface PlaylistRepairBatchSummary {
    rootPath: string;
    playlistCount: number;
    skippedCount: number;
    repairedCount: number;
    skippedPlaylistCount: number;
    failedCount: number;
    segmentCount: number;
    changedDurationCount: number;
    totalDurationDelta: number;
    results: PlaylistRepairSummary[];
    failures: Array<{ playlistPath: string; error: string }>;
}

interface PlaylistSegment {
    metadata: string[];
    name: string;
    originalDuration: number | null;
    repairedDuration: number | null;
    probe: SegmentProbe | null;
    probeFailed: boolean;
}

interface SegmentProbe {
    videoStart: number | null;
    videoDuration: number | null;
    audioDuration: number | null;
    formatDuration: number | null;
    needsFfprobeFallback: boolean;
}

interface ParsedPlaylist {
    lines: Array<PlaylistLine>;
    segments: PlaylistSegment[];
    targetDuration: number | null;
    hasMap: boolean;
}

type PlaylistLine =
    | { kind: "line"; value: string }
    | { kind: "target-duration"; value: string }
    | { kind: "segment"; segment: PlaylistSegment };

const PROBE_CONCURRENCY = 2;
const REPAIRED_DURATION_PRECISION = 6;
const DURATION_EPSILON_SECONDS = 0.0000005;
const SEGMENT_METADATA_PREFIXES = [
    HLS.INF_PREFIX,
    HLS.MAP_PREFIX,
    HLS.DISCONTINUITY,
    "#EXT-X-PROGRAM-DATE-TIME:",
    "#EXT-X-KEY:",
    "#EXT-X-BYTERANGE:",
];

function parseExtinfDuration(line: string): number | null {
    const value = line.slice(HLS.INF_PREFIX.length).split(",")[0];
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function formatExtinf(duration: number): string {
    return `${HLS.INF_PREFIX}${duration.toFixed(REPAIRED_DURATION_PRECISION)},`;
}

function parsePlaylist(content: string): ParsedPlaylist {
    const rawLines = content.split("\n");
    const lines: PlaylistLine[] = [];
    const segments: PlaylistSegment[] = [];
    let metadataBuffer: string[] = [];
    let targetDuration: number | null = null;
    let hasMap = false;

    for (const rawLine of rawLines) {
        const trimmed = rawLine.trim();
        if (trimmed === "") continue;
        if (trimmed.startsWith(HLS.MAP_PREFIX)) {
            hasMap = true;
        }

        if (trimmed.startsWith(HLS.TARGET_DURATION_PREFIX)) {
            const parsed = Number.parseInt(trimmed.slice(HLS.TARGET_DURATION_PREFIX.length), MISC.RADIX_DECIMAL);
            targetDuration = Number.isFinite(parsed) ? parsed : targetDuration;
            lines.push({ kind: "target-duration", value: trimmed });
            continue;
        }

        if (trimmed.startsWith("#")) {
            if (
                metadataBuffer.length === 0 &&
                !SEGMENT_METADATA_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
            ) {
                lines.push({ kind: "line", value: trimmed });
                continue;
            }
            metadataBuffer.push(trimmed);
            continue;
        }

        const originalDurationLine = metadataBuffer.find((line) => line.startsWith(HLS.INF_PREFIX));
        const segment: PlaylistSegment = {
            metadata: [...metadataBuffer],
            name: trimmed,
            originalDuration: originalDurationLine ? parseExtinfDuration(originalDurationLine) : null,
            repairedDuration: null,
            probe: null,
            probeFailed: false,
        };
        segments.push(segment);
        lines.push({ kind: "segment", segment });
        metadataBuffer = [];
    }

    for (const metadataLine of metadataBuffer) {
        lines.push({ kind: "line", value: metadataLine });
    }

    return { lines, segments, targetDuration, hasMap };
}

function normalizeHeaderOrder(lines: string[]): string[] {
    const firstSegmentIndex = lines.findIndex((line) => !line.startsWith("#"));
    const headerEnd = firstSegmentIndex === -1 ? lines.length : firstSegmentIndex;
    const header = lines.slice(0, headerEnd);
    const rest = lines.slice(headerEnd);
    const extm3u = header.find((line) => line === HLS.HEADER);
    const version = header.find((line) => line.startsWith("#EXT-X-VERSION"));
    const mediaSequence = header.find((line) => line.startsWith("#EXT-X-MEDIA-SEQUENCE"));
    const targetDuration = header.find((line) => line.startsWith(HLS.TARGET_DURATION_PREFIX));
    const orderedHeader = [extm3u, version, mediaSequence, targetDuration].filter((line): line is string => Boolean(line));
    const ordered = new Set(orderedHeader);
    const remainingHeader = header.filter((line) => !ordered.has(line));

    return [...orderedHeader, ...remainingHeader, ...rest];
}

function serializePlaylist(parsed: ParsedPlaylist, targetDuration: number): string {
    const output: string[] = [];

    for (const line of parsed.lines) {
        if (line.kind === "target-duration") {
            output.push(`${HLS.TARGET_DURATION_PREFIX}${targetDuration}`);
            continue;
        }

        if (line.kind === "line") {
            output.push(line.value);
            continue;
        }

        const duration = line.segment.repairedDuration ?? line.segment.originalDuration;
        for (const metadata of line.segment.metadata) {
            output.push(metadata.startsWith(HLS.INF_PREFIX) && duration !== null ? formatExtinf(duration) : metadata);
        }
        output.push(line.segment.name);
    }

    return normalizeHeaderOrder(output).join(MISC.NEW_LINE) + MISC.NEW_LINE;
}

function parseProbeNumber(value: unknown): number | null {
    if (typeof value !== "string" && typeof value !== "number") {
        return null;
    }
    const parsed = Number.parseFloat(String(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseProbeTime(value: unknown): number | null {
    if (typeof value !== "string" && typeof value !== "number") {
        return null;
    }
    const parsed = Number.parseFloat(String(value));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function hasDiscontinuityBefore(segment: PlaylistSegment): boolean {
    return segment.metadata.some((line) => line === HLS.DISCONTINUITY);
}

function chooseStreamDuration(probe: SegmentProbe | null): number | null {
    if (!probe) return null;
    return selectLongestMediaDuration(
        probe.videoDuration,
        probe.audioDuration,
        probe.formatDuration,
    );
}

function chooseTimelineDuration(segment: PlaylistSegment, next: PlaylistSegment | null): {
    duration: number | null;
    source: "video-timeline" | "stream-duration" | "missing";
} {
    const streamDuration = chooseStreamDuration(segment.probe);

    if (
        segment.probe?.videoStart !== null &&
        segment.probe?.videoStart !== undefined &&
        next?.probe?.videoStart !== null &&
        next?.probe?.videoStart !== undefined &&
        !hasDiscontinuityBefore(next)
    ) {
        const delta = next.probe.videoStart - segment.probe.videoStart;
        if (Number.isFinite(delta) && delta > 0) {
            return { duration: delta, source: "video-timeline" };
        }
    }

    return streamDuration === null
        ? { duration: null, source: "missing" }
        : { duration: streamDuration, source: "stream-duration" };
}

function probeSegment(segmentPath: string): Promise<SegmentProbe | null> {
    return new Promise((resolve) => {
        const child = spawn("ffprobe", [
            "-v", "error",
            "-show_entries", "format=duration:stream=codec_type,start_time,duration",
            "-of", "json",
            segmentPath,
        ]);
        let stdout = "";

        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf-8");
        });

        child.on("error", () => resolve(null));
        child.on("close", (code) => {
            if (code !== 0) {
                resolve(null);
                return;
            }
            try {
                const data = JSON.parse(stdout);
                const streams = Array.isArray(data.streams) ? data.streams : [];
                const video = streams.find((stream: any) => stream.codec_type === "video");
                const audio = streams.find((stream: any) => stream.codec_type === "audio");
                resolve({
                    videoStart: parseProbeTime(video?.start_time),
                    videoDuration: parseProbeNumber(video?.duration),
                    audioDuration: parseProbeNumber(audio?.duration),
                    formatDuration: parseProbeNumber(data.format?.duration),
                    needsFfprobeFallback: false,
                });
            } catch {
                resolve(null);
            }
        });
    });
}

function parseTsPts(buffer: Buffer, offset: number): number {
    const p32to30 = (buffer[offset] >> 1) & 0x07;
    const p29to15 = ((buffer[offset + 1] << 8) | buffer[offset + 2]) >> 1;
    const p14to0 = ((buffer[offset + 3] << 8) | buffer[offset + 4]) >> 1;
    return ((p32to30 * 2 ** 30) + (p29to15 * 2 ** 15) + p14to0) / 90000;
}

function estimateDurationFromPts(ptsValues: number[]): number | null {
    if (ptsValues.length < 4) return null;

    const deltas: number[] = [];
    for (let index = 1; index < ptsValues.length; index++) {
        const delta = ptsValues[index] - ptsValues[index - 1];
        if (Number.isFinite(delta) && delta > 0) {
            deltas.push(delta);
        }
    }
    if (deltas.length === 0) return null;

    const minDelta = Math.min(...deltas);
    const maxDelta = Math.max(...deltas);
    if (minDelta <= 0 || maxDelta / minDelta > 1.5) {
        return null;
    }

    return (ptsValues[ptsValues.length - 1] - ptsValues[0]) + minDelta;
}

function probeTsSegment(buffer: Buffer): SegmentProbe | null {
    const packetSize = 188;
    const videoPtsValues: number[] = [];
    const audioPtsValues: number[] = [];
    let videoPid: number | null = null;
    let audioPid: number | null = null;

    for (let packetStart = 0; packetStart + packetSize <= buffer.length; packetStart += packetSize) {
        if (buffer[packetStart] !== 0x47) continue;
        if ((buffer[packetStart + 1] & 0x40) === 0) continue;

        const pid = ((buffer[packetStart + 1] & 0x1f) << 8) | buffer[packetStart + 2];
        const adaptationControl = (buffer[packetStart + 3] >> 4) & 0x03;
        if (adaptationControl === 0 || adaptationControl === 2) continue;

        let payloadOffset = packetStart + 4;
        if (adaptationControl === 3) {
            payloadOffset += 1 + buffer[payloadOffset];
        }
        if (payloadOffset + 14 > packetStart + packetSize) continue;
        if (buffer[payloadOffset] !== 0 || buffer[payloadOffset + 1] !== 0 || buffer[payloadOffset + 2] !== 1) continue;

        const streamId = buffer[payloadOffset + 3];
        const ptsDtsFlags = (buffer[payloadOffset + 7] >> 6) & 0x03;
        if ((ptsDtsFlags & 0x02) === 0) continue;

        const pts = parseTsPts(buffer, payloadOffset + 9);
        if (streamId >= 0xe0 && streamId <= 0xef) {
            videoPid ??= pid;
            if (pid === videoPid) {
                videoPtsValues.push(pts);
            }
        } else if (streamId >= 0xc0 && streamId <= 0xdf) {
            audioPid ??= pid;
            if (pid === audioPid) {
                audioPtsValues.push(pts);
            }
        }
    }

    if (videoPtsValues.length === 0 && audioPtsValues.length === 0) {
        return null;
    }

    return {
        videoStart: videoPtsValues[0] ?? null,
        videoDuration: estimateDurationFromPts(videoPtsValues),
        audioDuration: estimateDurationFromPts(audioPtsValues),
        formatDuration: null,
        needsFfprobeFallback: true,
    };
}

async function probeSegmentBytes(segmentPath: string): Promise<SegmentProbe | null> {
    const buffer = await fs.readFile(segmentPath);
    if (buffer.length < 188 || buffer[0] !== 0x47) {
        return null;
    }
    return probeTsSegment(buffer);
}

export function requiresFfprobeFallback(
    duration: number | null,
    source: "video-timeline" | "stream-duration" | "missing",
    needsFfprobeFallback: boolean,
): boolean {
    return duration === null || (source === "stream-duration" && needsFfprobeFallback);
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    let handle;
    try {
        handle = await fs.open(tmpPath, "wx");
        await handle.writeFile(content, MISC.ENCODING_UTF8);
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(tmpPath, filePath);
        const directoryHandle = await fs.open(path.dirname(filePath), "r");
        try {
            await directoryHandle.sync();
        } finally {
            await directoryHandle.close();
        }
    } catch (error) {
        if (handle) await handle.close().catch(() => {});
        await fs.unlink(tmpPath).catch(() => {});
        throw error;
    }
}

export async function repairPlaylistDurations(
    videoPath: string,
    options: PlaylistRepairOptions = {},
): Promise<PlaylistRepairSummary> {
    const playlistPath = path.join(videoPath, FILE_NAMES.HLS_PLAYLIST);
    const originalContent = await fs.readFile(playlistPath, MISC.ENCODING_UTF8);
    const parsed = parsePlaylist(originalContent);

    if (parsed.hasMap) {
        const summary: PlaylistRepairSummary = {
            playlistPath,
            durationMode: "media-timeline",
            skipped: true,
            skipReason: "fmp4-map",
            segmentCount: parsed.segments.length,
            probedCount: 0,
            byteProbeCount: 0,
            ffprobeProbeCount: 0,
            failedProbeCount: 0,
            changedDurationCount: 0,
            missingSegmentCount: 0,
            videoTimelineCount: 0,
            streamDurationCount: 0,
            totalDurationBefore: Number(parsed.segments.reduce((sum, segment) => sum + (segment.originalDuration ?? 0), 0).toFixed(6)),
            totalDurationAfter: Number(parsed.segments.reduce((sum, segment) => sum + (segment.originalDuration ?? 0), 0).toFixed(6)),
            totalDurationDelta: 0,
            maxSegmentDelta: 0,
            targetDurationBefore: parsed.targetDuration,
            targetDurationAfter: parsed.targetDuration ?? 0,
            playlistChanged: false,
            wrotePlaylist: false,
            writeSkippedReason: null,
        };
        logger.info("[PlaylistAuthority] playlist-media-timeline-repair-skipped", summary);
        return summary;
    }

    const probeConcurrency = options.probeConcurrency ?? PROBE_CONCURRENCY;
    if (!Number.isInteger(probeConcurrency) || probeConcurrency < 1) {
        throw new Error("probeConcurrency must be a positive integer");
    }
    const limit = pLimit(probeConcurrency);

    let probedCount = 0;
    let byteProbeCount = 0;
    let ffprobeProbeCount = 0;
    let failedProbeCount = 0;
    let missingSegmentCount = 0;
    let changedDurationCount = 0;
    let videoTimelineCount = 0;
    let streamDurationCount = 0;
    let totalDurationBefore = 0;
    let totalDurationAfter = 0;
    let maxSegmentDelta = 0;

    await Promise.all(parsed.segments.map((segment) => limit(async () => {
        if (segment.originalDuration !== null) {
            totalDurationBefore += segment.originalDuration;
        }

        const segmentPath = path.join(videoPath, segment.name);
        try {
            await fs.access(segmentPath);
        } catch {
            missingSegmentCount++;
            failedProbeCount++;
            segment.probeFailed = true;
            segment.repairedDuration = segment.originalDuration;
            return;
        }

        await options.beforeProbe?.();
        const probe = await probeSegmentBytes(segmentPath);
        if (probe === null) {
            const ffprobe = await probeSegment(segmentPath);
            if (ffprobe === null) {
                failedProbeCount++;
                segment.probeFailed = true;
                segment.repairedDuration = segment.originalDuration;
                return;
            }
            segment.probe = ffprobe;
            ffprobeProbeCount++;
            probedCount++;
            return;
        }

        byteProbeCount++;
        probedCount++;
        segment.probe = probe;
    })));

    for (let index = 0; index < parsed.segments.length; index++) {
        const segment = parsed.segments[index];
        const nextSegment = parsed.segments[index + 1] ?? null;
        let { duration, source } = chooseTimelineDuration(segment, nextSegment);

        if (
            requiresFfprobeFallback(duration, source, segment.probe?.needsFfprobeFallback ?? false) &&
            !segment.probeFailed
        ) {
            await options.beforeProbe?.();
            const fallbackProbe = await probeSegment(path.join(videoPath, segment.name));
            if (fallbackProbe !== null) {
                ffprobeProbeCount++;
                segment.probe = {
                    videoStart: segment.probe?.videoStart ?? fallbackProbe.videoStart,
                    videoDuration: fallbackProbe.videoDuration,
                    audioDuration: fallbackProbe.audioDuration,
                    formatDuration: fallbackProbe.formatDuration,
                    needsFfprobeFallback: false,
                };
                ({ duration, source } = chooseTimelineDuration(segment, nextSegment));
            }
        }

        if (duration === null) {
            if (!segment.probeFailed) {
                failedProbeCount++;
            }
            segment.repairedDuration = segment.originalDuration;
            if (segment.originalDuration !== null) totalDurationAfter += segment.originalDuration;
            continue;
        }

        if (source === "video-timeline") {
            videoTimelineCount++;
        } else {
            streamDurationCount++;
        }

        segment.repairedDuration = duration;
        totalDurationAfter += duration;

        const delta = Math.abs(duration - (segment.originalDuration ?? duration));
        maxSegmentDelta = Math.max(maxSegmentDelta, delta);
        if (delta > DURATION_EPSILON_SECONDS) {
            changedDurationCount++;
        }
    }

    const maxDuration = parsed.segments.reduce((max, segment) => {
        const duration = segment.repairedDuration ?? segment.originalDuration ?? 0;
        return Math.max(max, duration);
    }, 0);
    const targetDurationAfter = Math.max(1, Math.ceil(maxDuration));
    const repairedContent = serializePlaylist(parsed, targetDurationAfter);
    const playlistChanged = repairedContent !== originalContent;
    let wrotePlaylist = false;
    let writeSkippedReason: PlaylistRepairSummary["writeSkippedReason"] = null;

    if (playlistChanged) {
        if (options.apply === false) {
            writeSkippedReason = "dry-run";
        } else if (options.beforeWrite && !await options.beforeWrite()) {
            writeSkippedReason = "write-guard";
        } else {
            await writeFileAtomic(playlistPath, repairedContent);
            wrotePlaylist = true;
        }
    }

    const summary: PlaylistRepairSummary = {
        playlistPath,
        durationMode: "media-timeline",
        skipped: false,
        skipReason: null,
        segmentCount: parsed.segments.length,
        probedCount,
        byteProbeCount,
        ffprobeProbeCount,
        failedProbeCount,
        changedDurationCount,
        missingSegmentCount,
        videoTimelineCount,
        streamDurationCount,
        totalDurationBefore: Number(totalDurationBefore.toFixed(6)),
        totalDurationAfter: Number(totalDurationAfter.toFixed(6)),
        totalDurationDelta: Number((totalDurationAfter - totalDurationBefore).toFixed(6)),
        maxSegmentDelta: Number(maxSegmentDelta.toFixed(6)),
        targetDurationBefore: parsed.targetDuration,
        targetDurationAfter,
        playlistChanged,
        wrotePlaylist,
        writeSkippedReason,
    };

    logger.info("[PlaylistAuthority] playlist-media-timeline-repair", summary);
    if (failedProbeCount > 0 || missingSegmentCount > 0) {
        logger.warn("[PlaylistAuthority] playlist-media-timeline-repair had probe issues", {
            playlistPath,
            failedProbeCount,
            missingSegmentCount,
        });
    }

    return summary;
}

async function findPlaylistFolders(rootPath: string, skipFolders: Set<string>): Promise<string[]> {
    const folders: string[] = [];
    const entries = await fs.readdir(rootPath, { withFileTypes: true });

    for (const entry of entries) {
        const entryPath = path.join(rootPath, entry.name);
        if (!entry.isDirectory()) continue;
        if (skipFolders.has(entryPath)) continue;

        try {
            await fs.access(path.join(entryPath, FILE_NAMES.HLS_PLAYLIST));
            folders.push(entryPath);
        } catch {
            continue;
        }
    }

    return folders.sort((a, b) => a.localeCompare(b));
}

export async function repairPlaylistDurationsUnder(rootPath: string, skipFolders: Set<string> = new Set()): Promise<PlaylistRepairBatchSummary> {
    const playlistFolders = await findPlaylistFolders(rootPath, skipFolders);
    const results: PlaylistRepairSummary[] = [];
    const failures: Array<{ playlistPath: string; error: string }> = [];

    logger.info("[PlaylistAuthority] playlist-batch-repair-start", {
        rootPath,
        playlistCount: playlistFolders.length,
        skippedCount: skipFolders.size,
        durationMode: "media-timeline",
    });

    for (const folder of playlistFolders) {
        try {
            results.push(await repairPlaylistDurations(folder));
        } catch (error: any) {
            failures.push({
                playlistPath: path.join(folder, FILE_NAMES.HLS_PLAYLIST),
                error: error?.message ?? String(error),
            });
            logger.error("[PlaylistAuthority] playlist-batch-repair-item-failed", {
                playlistPath: path.join(folder, FILE_NAMES.HLS_PLAYLIST),
                message: error?.message,
            });
        }
    }

    const summary: PlaylistRepairBatchSummary = {
        rootPath,
        playlistCount: playlistFolders.length,
        skippedCount: skipFolders.size,
        repairedCount: results.filter((result) => result.wrotePlaylist).length,
        skippedPlaylistCount: results.filter((result) => result.skipped).length,
        failedCount: failures.length,
        segmentCount: results.reduce((sum, result) => sum + result.segmentCount, 0),
        changedDurationCount: results.reduce((sum, result) => sum + result.changedDurationCount, 0),
        totalDurationDelta: Number(results.reduce((sum, result) => sum + result.totalDurationDelta, 0).toFixed(6)),
        results,
        failures,
    };

    logger.info("[PlaylistAuthority] playlist-batch-repair-finished", {
        rootPath: summary.rootPath,
        playlistCount: summary.playlistCount,
        skippedCount: summary.skippedCount,
        repairedCount: summary.repairedCount,
        skippedPlaylistCount: summary.skippedPlaylistCount,
        failedCount: summary.failedCount,
        segmentCount: summary.segmentCount,
        changedDurationCount: summary.changedDurationCount,
        totalDurationDelta: summary.totalDurationDelta,
    });

    return summary;
}
