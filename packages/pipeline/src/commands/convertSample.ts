import { mkdtemp, link, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { analyzeRecordingResolution, planRecordingShapes } from "../stages/resolutionPolicy.js";
import { convertShapeGroup } from "../stages/upscale.js";
import { videoEncoderLabel, type VideoEncoder } from "../stages/videoEncoder.js";

export interface ConvertedSample {
    readonly part: string;
    readonly path: string;
    readonly sizeBytes: number;
    readonly seconds: number;
}

// One recording folder converted as production converts it (the resolution policy's shapes,
// the same filters and container) into a folder of the caller's, by the production encoder
// or by NVENC on the GPU, to compare them. The ledger is never read or written; nothing is
// described or uploaded. An existing output file is never replaced.
export async function convertSample(source: string, outDir: string, encoder: VideoEncoder): Promise<ConvertedSample[]> {
    const playlist = source.endsWith(".m3u8") ? source : path.join(source, "playlist.m3u8");
    const recordingId = path.basename(path.dirname(path.resolve(playlist)));
    const analysis = await analyzeRecordingResolution(playlist);
    const shapes = planRecordingShapes(analysis);
    const groups = [...shapes.upload, ...shapes.manual].sort((a, b) => a.ordinal - b.ordinal);
    if (groups.length === 0) throw new Error(`${recordingId}: no shape to convert (${shapes.reason})`);
    const staging = await mkdtemp(path.join(outDir, ".convert-sample-"));
    const results: ConvertedSample[] = [];
    try {
        for (const group of groups) {
            const suffix = [videoEncoderLabel(encoder), group.part === "full" ? null : group.part,
                group.output.rotate ? "ccw" : null].filter(Boolean).join("-");
            const target = path.join(outDir, `${recordingId}.${suffix}.mp4`);
            if (await stat(target).then(() => true, () => false)) throw new Error(`${target} exists; it is never replaced`);
            const started = Date.now();
            const converted = await convertShapeGroup(playlist, staging, recordingId, group, suffix, analysis,
                groups.length > 1 ? group.indexes : undefined, encoder);
            await link(converted.path, target);
            await unlink(converted.path);
            results.push({ part: group.part, path: target, sizeBytes: (await stat(target)).size,
                seconds: Math.round((Date.now() - started) / 100) / 10 });
        }
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
    return results;
}
