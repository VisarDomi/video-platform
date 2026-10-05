import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseNativeMediaPlaylist, type NativeMediaSegment, type NativeMediaPlaylist } from "shared";
import type { ProductionArtifactPart } from "../domain/types.js";
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

// A segment that starts a run without an independently decodable video
// keyframe (e.g. a capture stub at a quality switch: P-slices referencing a
// missing PPS). It cannot be measured, but it is never dropped: it belongs to
// the picture that follows it and is converted with it. A zero-byte file holds
// no media at all; it is listed separately and never opened by the encoder.
export interface UnmeasuredSegment {
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
    // Measured segments only, in playlist order. Look them up by `index`,
    // never by array position: unmeasured segments leave gaps.
    readonly segments: readonly ResolutionSegment[];
    readonly undecodableSegments: readonly UnmeasuredSegment[];
    readonly emptySegments: readonly UnmeasuredSegment[];
    readonly sourceDimensions: readonly string[];
    readonly resolutionSummary: string;
    readonly maxPixelCount: number;
    // Things a person may want to know; none of them stops the conversion.
    readonly warnings: readonly string[];
}

type DimensionProbe = (inputPath: string) => Promise<VideoDimensions>;

// v5 (2026-10-05): every recording is converted; nothing is dropped; portrait
// is turned 90° counterclockwise; each shape is its own upload.
export const RESOLUTION_POLICY_VERSION = "resolution-policy-v5";
export const FULL_HD_PIXEL_COUNT = 1920 * 1080;
// Porntrex names its quality tiers by height, so Full HD needs both.
export const FULL_HD_HEIGHT = 1080;
// Display aspect ratios this close are one shape (rounding of even sizes).
export const SHAPE_TOLERANCE = 0.01;
// A shape split's pieces shorter than this are not uploaded; a person decides.
export const MINIMUM_SPLIT_PIECE_SECONDS = 60;
// More unmeasurable picture than this suggests a broken capture: worth a look.
const UNDECODABLE_WARNING_SHARE = 0.05;

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

function segmentList(segments: readonly UnmeasuredSegment[]): string {
    const listed = segments.slice(0, 20).map((segment) => `${segment.name} ${segment.durationSeconds.toFixed(6)}s`);
    if (segments.length > listed.length) listed.push(`+${segments.length - listed.length} more`);
    const total = segments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
    return `${listed.join(", ")}; total ${total.toFixed(6)}s`;
}

// Playlist indexes the encoder opens: all, within an optional selection, except
// zero-byte files (nothing to open). Undefined when that is every segment.
export function effectiveKeepIndexes(
    analysis: Pick<RecordingResolutionAnalysis, "playlist" | "emptySegments">,
    keepIndexes?: ReadonlySet<number>,
): ReadonlySet<number> | undefined {
    if (!analysis.emptySegments.length) return keepIndexes;
    const empty = new Set(analysis.emptySegments.map((segment) => segment.index));
    return new Set(analysis.playlist.segments.map((segment) => segment.index)
        .filter((index) => !empty.has(index) && (!keepIndexes || keepIndexes.has(index))));
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
        const scan = await probeTsSegmentDimensions(
            playlist.segments.map((segment) => path.join(sourceDirectory, segment.name)),
        );
        return buildAnalysis(resolvedPlaylist, sourceDirectory, playlist, scan.dimensions, scan.empty, scan.warnings);
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
    emptyPositions: ReadonlySet<number> = new Set(),
    probeWarnings: readonly string[] = [],
): RecordingResolutionAnalysis {
    if (dimensionsBySegment.length !== playlist.segments.length) {
        throw new Error("Resolution analysis does not match the playlist segment count");
    }
    const segments: ResolutionSegment[] = [];
    const undecodableSegments: UnmeasuredSegment[] = [];
    const emptySegments: UnmeasuredSegment[] = [];
    for (const [position, segment] of playlist.segments.entries()) {
        const unmeasured = { index: segment.index, name: segment.name, durationSeconds: segment.durationSeconds };
        if (emptyPositions.has(position)) {
            emptySegments.push(unmeasured);
            continue;
        }
        const dimensions = dimensionsBySegment[position];
        if (!dimensions) {
            // Mid-run, the decoder still holds the previous segment's state, so
            // a keyframe-less segment (long GOP) decodes in sequence and has the
            // previous segment's picture. Only a run start (playlist start,
            // discontinuity or new map) with no keyframe stays unmeasured.
            const prior = playlist.segments[position - 1];
            const kept = segments.at(-1);
            const startsRun = !prior || segment.metadata.includes("#EXT-X-DISCONTINUITY") || segment.mapUri !== prior.mapUri;
            if (!startsRun && kept && kept.index === prior.index) {
                segments.push({ width: kept.width, height: kept.height, sampleAspectRatio: kept.sampleAspectRatio,
                    streamLayout: kept.streamLayout, index: segment.index, name: segment.name, mapUri: segment.mapUri,
                    durationSeconds: segment.durationSeconds });
                continue;
            }
            undecodableSegments.push(unmeasured);
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
    // Nothing in the recording has a picture: there is nothing to convert.
    if (!segments.length) throw new Error("No playlist segment has an independently decodable video keyframe");
    const warnings = [...probeWarnings];
    const playlistDuration = playlist.segments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
    const undecodableDuration = undecodableSegments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
    if (undecodableSegments.length) {
        warnings.push(`${undecodableSegments.length} segment(s) start without a decodable keyframe and are converted `
            + `with the picture that follows (${segmentList(undecodableSegments)})`
            + (undecodableDuration > playlistDuration * UNDECODABLE_WARNING_SHARE
                ? `; that is over ${UNDECODABLE_WARNING_SHARE * 100}% of the recording, check the capture` : ""));
    }
    if (emptySegments.length) warnings.push(`${emptySegments.length} zero-byte segment file(s) hold no media (${segmentList(emptySegments)})`);
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
        emptySegments,
        sourceDimensions,
        resolutionSummary,
        maxPixelCount: Math.max(...segments.map((segment) => segment.width * segment.height)),
        warnings,
    };
}

function sampleAspectRatio(value: string | null): number {
    if (!value || value === "N/A" || value === "0:1") return 1;
    const match = value.match(/^(\d+):(\d+)$/);
    if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) return 1;
    return Number(match[1]) / Number(match[2]);
}

export function displayAspectRatio(dimensions: VideoDimensions): number {
    return dimensions.width * sampleAspectRatio(dimensions.sampleAspectRatio) / dimensions.height;
}

// Smallest even size at or above `value` (tolerant of float noise like 1920.0000001).
function ceilEven(value: number): number {
    return Math.max(2, 2 * Math.ceil(value / 2 - 1e-6));
}

export interface ProductionOutput {
    // Final frame size, after rotation.
    readonly width: number;
    readonly height: number;
    // Portrait pictures are turned 90° counterclockwise (head to the left).
    readonly rotate: boolean;
}

// One output size for a shape: the picture's display shape in landscape
// orientation, scaled up until it has at least Full HD's pixel count AND a
// height of at least 1080 (Porntrex names tiers by height). Never smaller than
// the source: neither display size nor coded pixel count shrinks. Square
// pixels; no crop, no padding.
export function productionOutputDimensions(source: VideoDimensions): ProductionOutput {
    if (!Number.isSafeInteger(source.width) || source.width <= 0 || !Number.isSafeInteger(source.height) || source.height <= 0) {
        throw new Error("Source has invalid dimensions");
    }
    const displayWidth = source.width * sampleAspectRatio(source.sampleAspectRatio);
    const displayHeight = source.height;
    const rotate = displayHeight > displayWidth;
    const width = rotate ? displayHeight : displayWidth;
    const height = rotate ? displayWidth : displayHeight;
    const scale = Math.max(
        1,
        Math.sqrt(FULL_HD_PIXEL_COUNT / (width * height)),
        FULL_HD_HEIGHT / height,
        Math.sqrt(source.width * source.height / (width * height)),
    );
    return { width: ceilEven(width * scale), height: ceilEven(height * scale), rotate };
}

export interface ShapeGroup {
    readonly part: ProductionArtifactPart;
    // 1-based, in order of first appearance in the recording.
    readonly ordinal: number;
    readonly displayAspectRatio: number;
    // Playlist indexes, including keyframe-less stubs; never zero-byte files.
    readonly indexes: ReadonlySet<number>;
    readonly segmentCount: number;
    readonly durationSeconds: number;
    // The largest picture of the shape (coded pixel count).
    readonly reference: ResolutionSegment;
    readonly sourceDimensions: readonly string[];
    readonly resolutionSummary: string;
    readonly output: ProductionOutput;
}

export interface RecordingShapePlan {
    // Converted and uploaded, in order of first appearance.
    readonly upload: readonly ShapeGroup[];
    // Pieces of a shape split shorter than a minute: kept for a person, not uploaded.
    readonly manual: readonly ShapeGroup[];
    readonly reason: string;
}

function describeGroup(group: ShapeGroup, manual: boolean): string {
    const aspect = group.displayAspectRatio.toFixed(4);
    const target = `${group.output.width}x${group.output.height}${group.output.rotate ? " turned 90° counterclockwise" : ""}`;
    return `${group.part} aspect ${aspect} ${group.durationSeconds.toFixed(3)}s (${group.resolutionSummary})`
        + (manual ? ` under ${MINIMUM_SPLIT_PIECE_SECONDS}s: manual handling, not uploaded` : ` -> ${target}`);
}

// Every segment is kept. Segments are grouped by display shape; one shape is
// one upload ("full"), several shapes are one upload each ("shape1", ...), and
// a split's pieces under a minute wait for a person.
export function planRecordingShapes(analysis: RecordingResolutionAnalysis): RecordingShapePlan {
    const groups: Array<{ aspect: number; members: ResolutionSegment[]; stubs: UnmeasuredSegment[] }> = [];
    const groupOf = new Map<number, number>();
    for (const segment of analysis.segments) {
        const aspect = displayAspectRatio(segment);
        let position = groups.findIndex((group) => Math.abs(aspect / group.aspect - 1) <= SHAPE_TOLERANCE);
        if (position < 0) position = groups.push({ aspect, members: [], stubs: [] }) - 1;
        groups[position].members.push(segment);
        groupOf.set(segment.index, position);
    }
    // A keyframe-less stub begins the picture that follows it (a quality switch).
    const measured = analysis.segments.map((segment) => segment.index);
    for (const stub of analysis.undecodableSegments) {
        const next = measured.find((index) => index > stub.index);
        const previous = [...measured].reverse().find((index) => index < stub.index);
        groups[groupOf.get(next ?? previous!)!].stubs.push(stub);
    }
    const split = groups.length > 1;
    const planned: ShapeGroup[] = groups.map((group, position) => {
        const reference = group.members.reduce((largest, segment) =>
            segment.width * segment.height > largest.width * largest.height ? segment : largest);
        const counts = new Map<string, number>();
        for (const segment of group.members) counts.set(dimensionKey(segment), (counts.get(dimensionKey(segment)) ?? 0) + 1);
        const indexes = new Set([...group.members.map((segment) => segment.index), ...group.stubs.map((stub) => stub.index)]);
        return {
            part: split ? `shape${position + 1}` as ProductionArtifactPart : "full",
            ordinal: position + 1,
            displayAspectRatio: group.aspect,
            indexes,
            segmentCount: indexes.size,
            durationSeconds: [...group.members, ...group.stubs].reduce((sum, segment) => sum + segment.durationSeconds, 0),
            reference,
            sourceDimensions: [...counts.keys()].sort(),
            resolutionSummary: [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => `${key}:${count}`).join(","),
            output: productionOutputDimensions(reference),
        };
    });
    const upload = planned.filter((group) => !split || group.durationSeconds >= MINIMUM_SPLIT_PIECE_SECONDS);
    const manual = planned.filter((group) => !upload.includes(group));
    const reason = `${planned.length === 1 ? "one shape" : `${planned.length} shapes, one upload each`}: `
        + planned.map((group) => describeGroup(group, manual.includes(group))).join("; ")
        + (analysis.warnings.length ? `; warnings: ${analysis.warnings.join("; ")}` : "");
    return { upload, manual, reason };
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
