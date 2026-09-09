import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { probeTsSegmentDimensions } from "./tsSegmentDimensions.js";

export interface VideoDimensions {
    readonly width: number;
    readonly height: number;
    readonly sampleAspectRatio: string | null;
}

export interface ResolutionSegment extends VideoDimensions {
    readonly durationSeconds: number;
    readonly index: number;
    readonly name: string;
    readonly mapUri: string | null;
}

interface ParsedSegment {
    readonly durationSeconds: number;
    readonly index: number;
    readonly name: string;
    readonly metadata: readonly string[];
    readonly mapLine: string | null;
    readonly mapUri: string | null;
}

interface ParsedPlaylist {
    readonly header: readonly string[];
    readonly segments: readonly ParsedSegment[];
}

export interface RecordingResolutionAnalysis {
    readonly playlistPath: string;
    readonly sourceDirectory: string;
    readonly playlist: ParsedPlaylist;
    readonly segments: readonly ResolutionSegment[];
    readonly sourceDimensions: readonly string[];
    readonly resolutionSummary: string;
    readonly maxPixelCount: number;
}

export type RecordingResolutionPolicy =
    | {
        readonly disposition: "convert1080";
        readonly source: VideoDimensions;
        readonly reason: string;
    }
    | {
        readonly disposition: "remuxNative";
        readonly reason: string;
    }
    | {
        readonly disposition: "retain1080";
        readonly retainedSegmentIndexes: ReadonlySet<number>;
        readonly reason: string;
    };

type DimensionProbe = (inputPath: string) => Promise<VideoDimensions>;

export const RESOLUTION_POLICY_VERSION = "resolution-policy-v3";
export const FULL_HD_PIXEL_COUNT = 1920 * 1080;

export function resolutionPolicyReason(reason: string): string {
    return `${RESOLUTION_POLICY_VERSION}: ${reason}`;
}

function safeLocalName(name: string, kind: string): string {
    if (name === "" || path.basename(name) !== name) {
        throw new Error(`Unsafe ${kind} URI in playlist: ${name}`);
    }
    return name;
}

function parseMapUri(line: string): string {
    const match = line.match(/\bURI="([^"]+)"/);
    if (!match) throw new Error(`Unsupported #EXT-X-MAP without a quoted URI: ${line}`);
    return safeLocalName(match[1], "map");
}

export function parseResolutionPlaylist(content: string): ParsedPlaylist {
    const header: string[] = [];
    const segments: ParsedSegment[] = [];
    const metadata: string[] = [];
    let currentMapLine: string | null = null;
    let currentMapUri: string | null = null;

    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === "" || line === "#EXT-X-ENDLIST") continue;
        if (
            line === "#EXTM3U"
            || line.startsWith("#EXT-X-VERSION:")
            || line.startsWith("#EXT-X-TARGETDURATION:")
            || line.startsWith("#EXT-X-MEDIA-SEQUENCE:")
            || line.startsWith("#EXT-X-PLAYLIST-TYPE:")
            || line === "#EXT-X-INDEPENDENT-SEGMENTS"
        ) {
            header.push(line);
        } else if (line.startsWith("#EXT-X-MAP:")) {
            currentMapLine = line;
            currentMapUri = parseMapUri(line);
        } else if (line.startsWith("#")) {
            if (line.startsWith("#EXT-X-KEY:") || line.startsWith("#EXT-X-BYTERANGE:")) {
                throw new Error(`Resolution policy does not support ${line.split(":", 1)[0]}`);
            }
            metadata.push(line);
        } else {
            const durations = metadata.filter((tag) => tag.startsWith("#EXTINF:"));
            const rawDuration = durations[0]?.match(/^#EXTINF:(\d+(?:\.\d+)?)(?:,.*)?$/)?.[1];
            const durationSeconds = Number(rawDuration);
            if (durations.length !== 1 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
                throw new Error(`Segment ${line} requires one positive #EXTINF duration`);
            }
            segments.push({
                durationSeconds,
                index: segments.length,
                name: safeLocalName(line, "segment"),
                metadata: [...metadata],
                mapLine: currentMapLine,
                mapUri: currentMapUri,
            });
            metadata.length = 0;
        }
    }
    if (segments.length === 0) throw new Error("Playlist contains no media segments");
    return { header, segments };
}

async function probeVideoDimensions(inputPath: string): Promise<VideoDimensions> {
    return await new Promise((resolve, reject) => {
        const child = spawn("ffprobe", [
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height,sample_aspect_ratio",
            "-of", "json",
            inputPath,
        ], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr = `${stderr}${chunk.toString()}`.slice(-16_384);
        });
        child.once("error", reject);
        child.once("close", (code) => {
            if (code !== 0) {
                reject(new Error(`ffprobe resolution probe failed (${code ?? "unknown"}): ${stderr.trim()}`));
                return;
            }
            try {
                const parsed = JSON.parse(stdout) as {
                    streams?: Array<{ width?: number; height?: number; sample_aspect_ratio?: string }>;
                };
                const stream = parsed.streams?.[0];
                if (!stream || !Number.isSafeInteger(stream.width) || (stream.width ?? 0) <= 0
                    || !Number.isSafeInteger(stream.height) || (stream.height ?? 0) <= 0) {
                    throw new Error(`No usable video dimensions in ${inputPath}`);
                }
                resolve({
                    width: stream.width as number,
                    height: stream.height as number,
                    sampleAspectRatio: stream.sample_aspect_ratio ?? null,
                });
            } catch (error) {
                reject(error);
            }
        });
    });
}


async function mapConcurrent<T, R>(
    values: readonly T[],
    concurrency: number,
    mapper: (value: T) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(values.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
        while (cursor < values.length) {
            const index = cursor++;
            results[index] = await mapper(values[index]);
        }
    });
    await Promise.all(workers);
    return results;
}

function dimensionKey(dimensions: VideoDimensions): string {
    return `${dimensions.width}x${dimensions.height}`;
}

export async function analyzeRecordingResolution(
    playlistPath: string,
    probe: DimensionProbe = probeVideoDimensions,
): Promise<RecordingResolutionAnalysis> {
    const resolvedPlaylist = path.resolve(playlistPath);
    const sourceDirectory = path.dirname(resolvedPlaylist);
    const content = await fs.readFile(resolvedPlaylist, "utf8");
    const playlist = parseResolutionPlaylist(content);
    if (probe === probeVideoDimensions && playlist.segments.every((segment) => segment.mapUri === null)) {
        const dimensionsBySegment = await probeTsSegmentDimensions(
            playlist.segments.map((segment) => path.join(sourceDirectory, segment.name)),
        );
        return buildAnalysis(resolvedPlaylist, sourceDirectory, playlist, dimensionsBySegment);
    }
    const probePaths = playlist.segments.map((segment) => path.join(
        sourceDirectory,
        segment.mapUri ?? segment.name,
    ));
    const uniqueProbePaths = [...new Set(probePaths)];
    const probed = await mapConcurrent(uniqueProbePaths, 8, probe);
    const dimensionsByPath = new Map(uniqueProbePaths.map((inputPath, index) => [inputPath, probed[index]]));
    return buildAnalysis(resolvedPlaylist, sourceDirectory, playlist, playlist.segments.map((segment, index) => {
        const dimensions = dimensionsByPath.get(probePaths[index]);
        if (!dimensions) throw new Error(`Resolution probe result is missing for ${segment.name}`);
        return dimensions;
    }));
}

function buildAnalysis(
    resolvedPlaylist: string,
    sourceDirectory: string,
    playlist: ParsedPlaylist,
    dimensionsBySegment: readonly VideoDimensions[],
): RecordingResolutionAnalysis {
    if (dimensionsBySegment.length !== playlist.segments.length) {
        throw new Error("Resolution analysis does not match the playlist segment count");
    }
    const segments = playlist.segments.map((segment, index): ResolutionSegment => ({
        ...dimensionsBySegment[index],
        index: segment.index,
        name: segment.name,
        mapUri: segment.mapUri,
        durationSeconds: segment.durationSeconds,
    }));
    const counts = new Map<string, number>();
    for (const segment of segments) {
        const key = dimensionKey(segment);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const sourceDimensions = [...counts.keys()].sort();
    const resolutionSummary = [...counts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([dimensions, count]) => `${dimensions}:${count}`)
        .join(",");
    return {
        playlistPath: resolvedPlaylist,
        sourceDirectory,
        playlist,
        segments,
        sourceDimensions,
        resolutionSummary,
        maxPixelCount: Math.max(...segments.map((segment) => segment.width * segment.height)),
    };
}

function sampleAspectRatio(value: string | null): number {
    if (!value || value === "N/A") return 1;
    const match = value.match(/^(\d+):(\d+)$/);
    if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) return Number.NaN;
    return Number(match[1]) / Number(match[2]);
}

function displayAspectRatio(dimensions: VideoDimensions): number {
    return dimensions.width * sampleAspectRatio(dimensions.sampleAspectRatio) / dimensions.height;
}

export function chooseRecordingResolutionPolicy(
    analysis: RecordingResolutionAnalysis,
): RecordingResolutionPolicy {
    // Full HD is a pixel budget, not a required shape or short edge. Count
    // coded pixels (not SAR-stretched display pixels) in either orientation.
    const high = analysis.segments.filter((segment) => segment.width * segment.height >= FULL_HD_PIXEL_COUNT);
    const low = analysis.segments.filter((segment) => segment.width * segment.height < FULL_HD_PIXEL_COUNT);
    const totalDuration = analysis.segments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
    const highDuration = high.reduce((sum, segment) => sum + segment.durationSeconds, 0);
    const share = highDuration / totalDuration;
    if (!Number.isFinite(share) || totalDuration <= 0) throw new Error("Cannot measure Full-HD-pixel-count duration share");
    const measured = `native >=${FULL_HD_PIXEL_COUNT} pixels duration ${highDuration.toFixed(6)}s / ${totalDuration.toFixed(6)}s (${(share * 100).toFixed(6)}%)`;
    if (low.length === 0) {
        return {
            disposition: "remuxNative",
            reason: `all ${high.length} segments have >=${FULL_HD_PIXEL_COUNT} pixels; remux at native resolutions without conversion (${analysis.resolutionSummary})`,
        };
    }
    if (share >= 0.9 - 1e-12) {
        return {
            disposition: "retain1080",
            retainedSegmentIndexes: new Set(high.map((segment) => segment.index)),
            reason: `${measured}; keep ${high.length} qualifying segments and drop ${low.length} segments below ${FULL_HD_PIXEL_COUNT} pixels from the upload; remux without conversion`,
        };
    }
    const source = analysis.segments.find(
        (segment) => segment.width * segment.height === analysis.maxPixelCount,
    );
    if (!source) throw new Error("Conversion policy has no reference source segment");
    const referenceAspect = displayAspectRatio(source);
    const consistentAspect = Number.isFinite(referenceAspect) && analysis.segments.every((segment) => {
        const aspect = displayAspectRatio(segment);
        return Number.isFinite(aspect) && Math.abs(aspect / referenceAspect - 1) <= 0.01;
    });
    if (!consistentAspect) {
        throw new Error(
            `Recording changes display aspect ratio (${analysis.resolutionSummary}); `
            + "cannot produce one unpadded 1080p artifact",
        );
    }
    return {
        disposition: "convert1080",
        source,
        reason: `${measured}; below 90%, convert the complete recording to 1080p with no segments dropped (${analysis.resolutionSummary})`,
    };
}

function absoluteMapLine(mapLine: string, mapUri: string, sourceDirectory: string): string {
    const absoluteUri = path.join(sourceDirectory, mapUri);
    return mapLine.replace(/\bURI="[^"]+"/, `URI="${absoluteUri}"`);
}

export function deriveResolutionPlaylist(
    analysis: RecordingResolutionAnalysis,
    keepIndexes: ReadonlySet<number>,
): string {
    const kept = analysis.playlist.segments.filter((segment) => keepIndexes.has(segment.index));
    if (kept.length === 0) throw new Error("Cannot derive an empty resolution playlist");
    const output = [...analysis.playlist.header];
    let previous: ParsedSegment | null = null;
    let emittedMapUri: string | null = null;

    for (const segment of kept) {
        const sourceDiscontinuity = segment.metadata.includes("#EXT-X-DISCONTINUITY");
        const selectionGap = previous !== null && segment.index !== previous.index + 1;
        const mapChanged = previous !== null && segment.mapUri !== previous.mapUri;
        if (previous !== null && (sourceDiscontinuity || selectionGap || mapChanged)) {
            output.push("#EXT-X-DISCONTINUITY");
        }
        if (segment.mapLine && segment.mapUri && segment.mapUri !== emittedMapUri) {
            output.push(absoluteMapLine(segment.mapLine, segment.mapUri, analysis.sourceDirectory));
            emittedMapUri = segment.mapUri;
        }
        output.push(...segment.metadata.filter((line) => line !== "#EXT-X-DISCONTINUITY"));
        output.push(path.join(analysis.sourceDirectory, segment.name));
        previous = segment;
    }
    output.push("#EXT-X-ENDLIST");
    return `${output.join("\n")}\n`;
}
