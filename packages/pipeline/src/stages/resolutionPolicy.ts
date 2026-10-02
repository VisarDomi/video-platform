import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseNativeMediaPlaylist, type NativeMediaSegment, type NativeMediaPlaylist } from "shared";
import { probeTsSegmentDimensions } from "./tsSegmentDimensions.js";

export interface VideoDimensions {
    readonly width: number;
    readonly height: number;
    readonly sampleAspectRatio: string | null;
    readonly streamLayout?: readonly NativeStreamLayout[];
}

export interface NativeStreamLayout {
    readonly codec_type: string;
    readonly codec_name: string;
    readonly time_base: string;
    readonly pix_fmt?: string;
    readonly sample_rate?: string;
    readonly channels?: number;
    readonly channel_layout?: string;
    readonly start_time?: string;
    readonly width?: number;
    readonly height?: number;
    readonly profile?: string;
}

export interface ResolutionSegment extends VideoDimensions {
    readonly durationSeconds: number;
    readonly index: number;
    readonly name: string;
    readonly mapUri: string | null;
}

// A segment with no independently decodable video keyframe (e.g. a capture
// stub at a quality switch: P-slices referencing a missing PPS). No decoder can
// show its picture, so it is excluded from classification and every artifact.
export interface UndecodableSegment {
    readonly index: number;
    readonly name: string;
    readonly durationSeconds: number;
}

type ParsedSegment = NativeMediaSegment;
type ParsedPlaylist = NativeMediaPlaylist;

export interface RecordingResolutionAnalysis {
    readonly playlistPath: string;
    readonly sourceDirectory: string;
    readonly playlist: ParsedPlaylist;
    // Decodable segments only, in playlist order. Look them up by `index`,
    // never by array position: dropped segments leave gaps.
    readonly segments: readonly ResolutionSegment[];
    readonly undecodableSegments: readonly UndecodableSegment[];
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

export const RESOLUTION_POLICY_VERSION = "resolution-policy-v4";
export const FULL_HD_PIXEL_COUNT = 1920 * 1080;
// Undecodable stubs are sub-second leftovers at quality switches. Even one per
// 20 s of stream stays far below this share. Losing more means the scan or the
// capture is systematically broken, so the recording fails closed instead.
export const MAX_UNDECODABLE_DURATION_SHARE = 0.05;

export function resolutionPolicyReason(reason: string): string {
    return `${RESOLUTION_POLICY_VERSION}: ${reason}`;
}

export function parseResolutionPlaylist(content: string): ParsedPlaylist {
    const parsed = parseNativeMediaPlaylist(content);
    if (!parsed.segments.length) throw new Error("Playlist contains no media segments");
    return parsed;
}

async function probeVideoDimensions(inputPath: string): Promise<VideoDimensions> {
    return await new Promise((resolve, reject) => {
        const child = spawn("ffprobe", [
            "-v", "error",
            "-show_entries", "stream=codec_type,codec_name,time_base,pix_fmt,sample_rate,channels,channel_layout,width,height,sample_aspect_ratio,profile",
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
                    streams?: Array<NativeStreamLayout & { width?: number; height?: number; sample_aspect_ratio?: string }>;
                };
                const stream = parsed.streams?.find(stream => stream.codec_type === "video");
                if (!stream || !Number.isSafeInteger(stream.width) || (stream.width ?? 0) <= 0
                    || !Number.isSafeInteger(stream.height) || (stream.height ?? 0) <= 0) {
                    throw new Error(`No usable video dimensions in ${inputPath}`);
                }
                resolve({
                    width: stream.width as number,
                    height: stream.height as number,
                    sampleAspectRatio: stream.sample_aspect_ratio ?? null,
                    streamLayout: parsed.streams?.filter(stream => ["video", "audio"].includes(stream.codec_type)),
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

export function undecodableSegmentsNote(analysis: Pick<RecordingResolutionAnalysis, "undecodableSegments">): string {
    const dropped = analysis.undecodableSegments;
    if (!dropped.length) return "";
    const listed = dropped.slice(0, 20).map((segment) => `${segment.name} ${segment.durationSeconds.toFixed(6)}s`);
    if (dropped.length > listed.length) listed.push(`+${dropped.length - listed.length} more`);
    const total = dropped.reduce((sum, segment) => sum + segment.durationSeconds, 0);
    return `; dropped ${dropped.length} segment(s) with no independently decodable video keyframe `
        + `(${listed.join(", ")}; total ${total.toFixed(6)}s)`;
}

// Decodable playlist indexes, intersected with an optional policy selection.
// Undefined only when nothing is dropped and no selection applies.
export function effectiveKeepIndexes(
    analysis: Pick<RecordingResolutionAnalysis, "segments" | "undecodableSegments">,
    keepIndexes?: ReadonlySet<number>,
): ReadonlySet<number> | undefined {
    if (!analysis.undecodableSegments.length) return keepIndexes;
    return new Set(analysis.segments.map((segment) => segment.index)
        .filter((index) => !keepIndexes || keepIndexes.has(index)));
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
    dimensionsBySegment: ReadonlyArray<VideoDimensions | null>,
): RecordingResolutionAnalysis {
    if (dimensionsBySegment.length !== playlist.segments.length) {
        throw new Error("Resolution analysis does not match the playlist segment count");
    }
    const segments: ResolutionSegment[] = [];
    const undecodableSegments: UndecodableSegment[] = [];
    for (const [index, segment] of playlist.segments.entries()) {
        const dimensions = dimensionsBySegment[index];
        if (!dimensions) {
            // Mid-run, the decoder still holds the previous segment's state, so
            // a keyframe-less segment (long GOP) decodes in sequence: keep it.
            // Only a run start (playlist start, discontinuity or new map) with
            // no keyframe has nothing to decode from, like a quality-switch stub.
            const prior = playlist.segments[index - 1];
            const kept = segments.at(-1);
            const startsRun = !prior || segment.metadata.includes("#EXT-X-DISCONTINUITY") || segment.mapUri !== prior.mapUri;
            if (!startsRun && kept && kept.index === prior.index) {
                segments.push({ width: kept.width, height: kept.height, sampleAspectRatio: kept.sampleAspectRatio,
                    streamLayout: kept.streamLayout, index: segment.index, name: segment.name, mapUri: segment.mapUri,
                    durationSeconds: segment.durationSeconds });
                continue;
            }
            undecodableSegments.push({ index: segment.index, name: segment.name, durationSeconds: segment.durationSeconds });
            continue;
        }
        segments.push({
            ...dimensions,
            index: segment.index,
            name: segment.name,
            mapUri: segment.mapUri,
            durationSeconds: segment.durationSeconds,
        });
    }
    if (!segments.length) throw new Error("No playlist segment has an independently decodable video keyframe");
    const playlistDuration = playlist.segments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
    const droppedDuration = undecodableSegments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
    if (droppedDuration > playlistDuration * MAX_UNDECODABLE_DURATION_SHARE) {
        throw new Error(`Undecodable segments cover ${droppedDuration.toFixed(6)}s of ${playlistDuration.toFixed(6)}s `
            + `(above ${MAX_UNDECODABLE_DURATION_SHARE * 100}%); refusing to drop them`
            + undecodableSegmentsNote({ undecodableSegments }));
    }
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
        undecodableSegments,
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

export function conversionReferenceSource(segments: readonly ResolutionSegment[]): VideoDimensions {
    const source = segments.reduce<ResolutionSegment | undefined>((largest, segment) =>
        !largest || segment.width * segment.height > largest.width * largest.height ? segment : largest, undefined);
    if (!source) throw new Error("Conversion policy has no reference source segment");
    const referenceAspect = displayAspectRatio(source);
    if (!Number.isFinite(referenceAspect) || !segments.every(segment => {
        const aspect = displayAspectRatio(segment);
        return Number.isFinite(aspect) && Math.abs(aspect / referenceAspect - 1) <= 0.01;
    })) throw new Error("Recording changes display aspect ratio; cannot produce one unpadded 1080p artifact");
    return source;
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
    const dropped = undecodableSegmentsNote(analysis);
    const measured = `native >=${FULL_HD_PIXEL_COUNT} pixels duration ${highDuration.toFixed(6)}s / ${totalDuration.toFixed(6)}s (${(share * 100).toFixed(6)}%)`;
    if (low.length === 0) {
        return {
            disposition: "remuxNative",
            reason: `all ${high.length} segments have >=${FULL_HD_PIXEL_COUNT} pixels; remux at native resolutions without conversion (${analysis.resolutionSummary})${dropped}`,
        };
    }
    if (share >= 0.9 - 1e-12) {
        return {
            disposition: "retain1080",
            retainedSegmentIndexes: new Set(high.map((segment) => segment.index)),
            reason: `${measured}; keep ${high.length} qualifying segments and drop ${low.length} segments below ${FULL_HD_PIXEL_COUNT} pixels from the upload; remux without conversion${dropped}`,
        };
    }
    const source = conversionReferenceSource(analysis.segments);
    return {
        disposition: "convert1080",
        source,
        reason: `${measured}; below 90%, convert the complete recording to 1080p with no ${dropped ? "decodable " : ""}segments dropped (${analysis.resolutionSummary})${dropped}`,
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
    const keep = effectiveKeepIndexes(analysis, keepIndexes) ?? keepIndexes;
    const kept = analysis.playlist.segments.filter((segment) => keep.has(segment.index));
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
