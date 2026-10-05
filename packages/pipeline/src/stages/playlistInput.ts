import { promises as fs } from "node:fs";
import path from "node:path";
import { nativeMediaRuns, renderNativeMediaRun } from "shared";
import { effectiveKeepIndexes, parseResolutionPlaylist, type RecordingResolutionAnalysis, type ResolutionSegment } from "./resolutionPolicy.js";
import { nativeStreamCompatibility, probeNativeStreamLayout, type NativeInputRun } from "./mediaCompatibility.js";

export interface PlaylistSelection {
    readonly analysis: RecordingResolutionAnalysis;
    readonly keepIndexes?: ReadonlySet<number>;
}

// HLS discontinuities are decoder/timestamp boundaries. Feeding independent
// fMP4 runs straight into one HLS transcode can expose reset PTS to fps_mode
// and silently discard later frames. Concat opens each run independently and
// offsets its timestamps onto the continuous playlist timeline.
// Observed dimension/SAR changes create the same boundaries even if capture
// omitted EXT-X-DISCONTINUITY. These are temporary input runs, not source edits.
// Every selected segment is kept, except zero-byte files (nothing to open). A
// segment without a decodable keyframe takes the picture that follows it, so
// it starts that picture's run instead of hiding the boundary.
export async function preparePlaylistInput(input: string, stagingRoot: string, selection?: PlaylistSelection): Promise<{
    args: string[];
    runs?: NativeInputRun[];
    incompatibility?: string | null;
    cleanup(): Promise<void>;
}> {
    if (!input.endsWith(".m3u8")) return { args: ["-i", input], cleanup: async () => {} };
    const parsed = selection?.analysis.playlist ?? parseResolutionPlaylist(await fs.readFile(input, "utf8"));
    const keepIndexes = selection ? effectiveKeepIndexes(selection.analysis, selection.keepIndexes) : undefined;
    const measured = selection?.analysis.segments ?? [];
    const pictureOf = new Map<number, ResolutionSegment>();
    let next = 0;
    for (const segment of parsed.segments) {
        while (next < measured.length && measured[next].index < segment.index) next++;
        const picture = measured[next] ?? measured.at(-1);
        if (picture) pictureOf.set(segment.index, picture);
    }
    const runs = nativeMediaRuns(parsed.segments.filter(segment =>
        !keepIndexes || keepIndexes.has(segment.index)), (prior, segment) => {
        const priorDimensions = pictureOf.get(prior.index);
        const dimensions = pictureOf.get(segment.index);
        const geometryChanged = priorDimensions && dimensions && (priorDimensions.width !== dimensions.width
            || priorDimensions.height !== dimensions.height || priorDimensions.sampleAspectRatio !== dimensions.sampleAspectRatio);
        return Boolean(geometryChanged);
    });
    const analyzed = pictureOf;
    if (runs.length === 0) throw new Error("Cannot remux an empty selection");
    // One decoder across runs would read a keyframe-less run start against the
    // previous run's parameters and show garbage; decoded on its own, its
    // picture is skipped cleanly and its audio is kept.
    const keyframeless = new Set(selection?.analysis.undecodableSegments.map((segment) => segment.index) ?? []);
    const runStartsWithoutKeyframe = runs.slice(1).some((run) => keyframeless.has(run[0].index))
        ? "a run starts without a decodable keyframe; decode each run on its own" : null;
    if (runs.length === 1 && !keepIndexes) {
        const layout = analyzed.get(runs[0][0].index)?.streamLayout ?? await probeNativeStreamLayout(input);
        return { args: ["-i", input], runs: [{ path: input, layout,
            durationSeconds: runs[0].reduce((sum, segment) => sum + segment.durationSeconds, 0) }],
            incompatibility: nativeStreamCompatibility([layout]), cleanup: async () => {} };
    }
    await fs.mkdir(stagingRoot, { recursive: true });
    const temporary = await fs.mkdtemp(path.join(stagingRoot, ".playlist-input-"));
    const cleanup = () => fs.rm(temporary, { recursive: true, force: true });
    const sourceRoot = selection?.analysis.sourceDirectory ?? path.dirname(path.resolve(input));
    try {
        const concat = ["ffconcat version 1.0"];
        const inputs: NativeInputRun[] = [];
        for (const [index, run] of runs.entries()) {
            const runPath = path.join(temporary, `${index}.m3u8`);
            await fs.writeFile(runPath, renderNativeMediaRun(run, sourceRoot), { flag: "wx" });
            const layout = analyzed.get(run[0].index)?.streamLayout ?? await probeNativeStreamLayout(runPath);
            inputs.push({ path: runPath, layout, durationSeconds: run.reduce((sum, segment) => sum + segment.durationSeconds, 0),
                pictureless: run.every((segment) => keyframeless.has(segment.index)) });
            concat.push(`file '${runPath.replaceAll("'", "'\\''")}'`,
                `duration ${run.reduce((sum, segment) => sum + segment.durationSeconds, 0).toFixed(9)}`);
        }
        const concatPath = path.join(temporary, "runs.ffconcat");
        await fs.writeFile(concatPath, concat.join("\n") + "\n", { flag: "wx" });
        return { args: ["-f", "concat", "-safe", "0", "-protocol_whitelist", "file,crypto,data", "-i", concatPath],
            runs: inputs, incompatibility: nativeStreamCompatibility(inputs.map(run => run.layout)) ?? runStartsWithoutKeyframe, cleanup };
    } catch (error) {
        await cleanup();
        throw error;
    }
}
