import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createInterface } from "node:readline";

import type { ArtifactVariant } from "../domain/types.js";
import { prepareAtomicRemuxPaths } from "./remux.js";

export type UpscaleMode = ArtifactVariant;

export interface UpscaleSpecification {
    readonly mode: UpscaleMode;
    readonly sourceShortEdgeFloor: number;
    readonly targetShortEdge: number;
}

export const UPSCALE_SPECIFICATIONS: Readonly<Record<UpscaleMode, UpscaleSpecification>> = {
    upscale1080p: {
        mode: "upscale1080p",
        sourceShortEdgeFloor: 720,
        targetShortEdge: 1080,
    },
    upscale1440p: {
        mode: "upscale1440p",
        sourceShortEdgeFloor: 1080,
        targetShortEdge: 1440,
    },
};

export interface SourceVideoFrame {
    readonly width: number;
    readonly height: number;
    readonly sampleAspectRatio: string | null;
}

interface FrameRange {
    readonly start: number;
    readonly end: number;
}

export interface UpscalePlan {
    readonly specification: UpscaleSpecification;
    readonly sourceFrameCount: number;
    readonly droppedSourceFrames: number;
    readonly droppedFrameRanges: readonly FrameRange[];
    readonly outputWidth: number;
    readonly outputHeight: number;
    readonly outputDisplayAspectRatio: number;
    readonly selectExpression: string | null;
}

export interface UpscaleTranscodeResult {
    readonly path: string;
    readonly plan: UpscalePlan;
}

export interface FixedUpscaleSource {
    readonly width: number;
    readonly height: number;
    readonly sampleAspectRatio: string | null;
}

function parseSampleAspectRatio(value: string | null): number {
    if (value === null || value === "" || value === "N/A") return 1;
    const match = value.match(/^(\d+):(\d+)$/);
    if (!match) throw new Error(`Unsupported sample aspect ratio ${value}`);
    const numerator = Number.parseInt(match[1], 10);
    const denominator = Number.parseInt(match[2], 10);
    if (numerator <= 0 || denominator <= 0) throw new Error(`Invalid sample aspect ratio ${value}`);
    return numerator / denominator;
}

function evenDimension(value: number): number {
    return Math.max(2, Math.round(value / 2) * 2);
}

function targetDimensions(frame: SourceVideoFrame, targetShortEdge: number): {
    width: number;
    height: number;
    displayAspectRatio: number;
} {
    const displayAspectRatio = frame.width * parseSampleAspectRatio(frame.sampleAspectRatio) / frame.height;
    if (!Number.isFinite(displayAspectRatio) || displayAspectRatio <= 0) {
        throw new Error("Source frame has no valid display aspect ratio");
    }
    if (displayAspectRatio >= 1) {
        return {
            width: evenDimension(targetShortEdge * displayAspectRatio),
            height: targetShortEdge,
            displayAspectRatio,
        };
    }
    return {
        width: targetShortEdge,
        height: evenDimension(targetShortEdge / displayAspectRatio),
        displayAspectRatio,
    };
}

function droppedSelectionExpression(ranges: readonly FrameRange[]): string | null {
    if (ranges.length === 0) return null;
    const excluded = ranges.map((range) => range.start === range.end
        ? `eq(n\\,${range.start})`
        : `between(n\\,${range.start}\\,${range.end})`);
    const expression = `not(${excluded.join("+")})`;
    if (expression.length > 60_000) {
        throw new Error("Source changes resolution too often to safely express dropped frame ranges");
    }
    return expression;
}

export function createUpscalePlan(
    frames: readonly SourceVideoFrame[],
    mode: UpscaleMode,
    displayRotation = 0,
): UpscalePlan {
    if (frames.length === 0) throw new Error("Source contains no decoded video frames");
    if (displayRotation % 360 !== 0) {
        throw new Error(`Upscale refuses display-rotation metadata (${displayRotation} degrees); normalize orientation first`);
    }
    const specification = UPSCALE_SPECIFICATIONS[mode];
    const droppedFrameRanges: FrameRange[] = [];
    let openDroppedRange: { start: number; end: number } | null = null;
    let droppedSourceFrames = 0;
    let plannedDimensions: ReturnType<typeof targetDimensions> | null = null;

    for (let index = 0; index < frames.length; index++) {
        const frame = frames[index];
        if (!Number.isSafeInteger(frame.width) || frame.width <= 0
            || !Number.isSafeInteger(frame.height) || frame.height <= 0) {
            throw new Error(`Source frame ${index} has invalid dimensions`);
        }
        if (Math.min(frame.width, frame.height) < specification.sourceShortEdgeFloor) {
            droppedSourceFrames++;
            if (openDroppedRange === null) openDroppedRange = { start: index, end: index };
            else openDroppedRange.end = index;
            continue;
        }
        if (openDroppedRange !== null) {
            droppedFrameRanges.push(openDroppedRange);
            openDroppedRange = null;
        }
        const dimensions = targetDimensions(frame, specification.targetShortEdge);
        if (plannedDimensions === null) plannedDimensions = dimensions;
        else if (plannedDimensions.width !== dimensions.width || plannedDimensions.height !== dimensions.height) {
            throw new Error(
                `Qualifying source frames do not share one display aspect ratio: `
                + `${plannedDimensions.width}x${plannedDimensions.height} versus ${dimensions.width}x${dimensions.height}`,
            );
        }
    }
    if (openDroppedRange !== null) droppedFrameRanges.push(openDroppedRange);
    if (plannedDimensions === null) {
        throw new Error(
            `Source has no frames with a short edge of at least ${specification.sourceShortEdgeFloor} pixels`,
        );
    }
    return {
        specification,
        sourceFrameCount: frames.length,
        droppedSourceFrames,
        droppedFrameRanges,
        outputWidth: plannedDimensions.width,
        outputHeight: plannedDimensions.height,
        outputDisplayAspectRatio: plannedDimensions.width / plannedDimensions.height,
        selectExpression: droppedSelectionExpression(droppedFrameRanges),
    };
}

async function probeDisplayRotation(inputPath: string): Promise<number> {
    return await new Promise((resolve, reject) => {
        const child = spawn("ffprobe", [
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream_side_data=rotation",
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
                reject(new Error(`ffprobe rotation scan failed (${code ?? "unknown"}): ${stderr.trim()}`));
                return;
            }
            try {
                const parsed = JSON.parse(stdout) as {
                    streams?: Array<{ side_data_list?: Array<{ rotation?: number }> }>;
                };
                const rotation = parsed.streams?.[0]?.side_data_list
                    ?.find((entry) => typeof entry.rotation === "number")?.rotation ?? 0;
                resolve(rotation);
            } catch (error) {
                reject(error);
            }
        });
    });
}

async function probeVideoFrames(inputPath: string): Promise<SourceVideoFrame[]> {
    return await new Promise((resolve, reject) => {
        const child = spawn("ffprobe", [
            "-v", "error",
            "-select_streams", "v:0",
            "-show_frames",
            "-show_entries", "frame=width,height,sample_aspect_ratio",
            "-of", "csv=p=0",
            inputPath,
        ], { stdio: ["ignore", "pipe", "pipe"] });
        const frames: SourceVideoFrame[] = [];
        let stderr = "";
        const lines = createInterface({ input: child.stdout });
        lines.on("line", (line) => {
            const match = line.match(/^(\d+),(\d+)(?:,([^,]+))?/);
            if (!match) return;
            frames.push({
                width: Number.parseInt(match[1], 10),
                height: Number.parseInt(match[2], 10),
                sampleAspectRatio: match[3] ?? null,
            });
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr = `${stderr}${chunk.toString()}`.slice(-16_384);
        });
        child.once("error", reject);
        child.once("close", (code) => {
            if (code === 0) resolve(frames);
            else reject(new Error(`ffprobe frame scan failed (${code ?? "unknown"}): ${stderr.trim()}`));
        });
    });
}

export async function analyzeUpscaleSource(inputPath: string, mode: UpscaleMode): Promise<UpscalePlan> {
    const [frames, displayRotation] = await Promise.all([
        probeVideoFrames(inputPath),
        probeDisplayRotation(inputPath),
    ]);
    return createUpscalePlan(frames, mode, displayRotation);
}

export function buildUpscaleTranscodeArgs(
    inputPath: string,
    temporaryOutput: string,
    plan: UpscalePlan,
): string[] {
    const filters = [];
    if (plan.selectExpression !== null) filters.push(`select='${plan.selectExpression}'`);
    filters.push(`zscale=w=${plan.outputWidth}:h=${plan.outputHeight}:filter=lanczos`);
    filters.push("setsar=1");
    return [
        "-nostdin",
        "-hide_banner",
        "-v", "error",
        "-fflags", "+genpts",
        "-i", inputPath,
        "-map", "0:v:0",
        "-map", "0:a?",
        "-vf", filters.join(","),
        "-c:v", "libx264",
        "-preset", "slow",
        "-crf", "16",
        "-pix_fmt", "yuv420p",
        "-fps_mode:v", "vfr",
        "-c:a", "copy",
        "-movflags", "+faststart",
        "-f", "mp4",
        temporaryOutput,
    ];
}

export async function upscaleTranscode(
    inputPath: string,
    stagingRoot: string,
    recordingId: string,
    mode: UpscaleMode,
): Promise<UpscaleTranscodeResult> {
    const plan = await analyzeUpscaleSource(inputPath, mode);
    return await runUpscaleTranscode(inputPath, stagingRoot, recordingId, plan, mode);
}

async function runUpscaleTranscode(
    inputPath: string,
    stagingRoot: string,
    recordingId: string,
    plan: UpscalePlan,
    artifactSuffix?: string,
): Promise<UpscaleTranscodeResult> {
    const { finalPath, temporaryPath } = await prepareAtomicRemuxPaths(
        stagingRoot,
        recordingId,
        artifactSuffix,
    );
    const existing = await fs.lstat(finalPath).catch(() => null);
    if (existing?.isFile()) return { path: finalPath, plan };
    if (existing) throw new Error(`Refusing to replace non-file artifact path ${finalPath}`);
    try {
        await new Promise<void>((resolve, reject) => {
            const child = spawn("ffmpeg", buildUpscaleTranscodeArgs(inputPath, temporaryPath, plan), {
                stdio: ["ignore", "ignore", "pipe"],
            });
            let stderr = "";
            child.stderr.on("data", (chunk: Buffer) => {
                stderr = `${stderr}${chunk.toString()}`.slice(-16_384);
            });
            child.once("error", reject);
            child.once("close", (code) => {
                if (code === 0) resolve();
                else reject(new Error(`ffmpeg upscale transcode failed (${code ?? "unknown"}): ${stderr.trim()}`));
            });
        });
        try {
            await fs.link(temporaryPath, finalPath);
        } catch (error) {
            const raced = await fs.lstat(finalPath).catch(() => null);
            if (!raced?.isFile()) throw error;
        }
        await fs.unlink(temporaryPath);
        return { path: finalPath, plan };
    } catch (error) {
        await fs.unlink(temporaryPath).catch(() => undefined);
        throw error;
    }
}

export async function upscaleWholeRecordingTo1080(
    inputPath: string,
    stagingRoot: string,
    recordingId: string,
    source: FixedUpscaleSource,
    artifactSuffix = "production-upscale1080p",
): Promise<UpscaleTranscodeResult> {
    // Production conversion includes every segment, even for all-360p/480p
    // sources. The supervised comparison mode's 720p floor does not apply.
    const dimensions = targetDimensions(source, 1080);
    const plan: UpscalePlan = {
        specification: { mode: "upscale1080p", sourceShortEdgeFloor: 0, targetShortEdge: 1080 },
        sourceFrameCount: 1,
        droppedSourceFrames: 0,
        droppedFrameRanges: [],
        outputWidth: dimensions.width,
        outputHeight: dimensions.height,
        outputDisplayAspectRatio: dimensions.width / dimensions.height,
        selectExpression: null,
    };
    return await runUpscaleTranscode(
        inputPath,
        stagingRoot,
        recordingId,
        plan,
        artifactSuffix,
    );
}
