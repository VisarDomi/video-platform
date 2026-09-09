import { promises as fs } from "node:fs";
import path from "node:path";
import { parseResolutionPlaylist, type RecordingResolutionAnalysis } from "./resolutionPolicy.js";

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
export async function preparePlaylistInput(input: string, stagingRoot: string, selection?: PlaylistSelection): Promise<{
    args: string[];
    cleanup(): Promise<void>;
}> {
    if (!input.endsWith(".m3u8")) return { args: ["-i", input], cleanup: async () => {} };
    const parsed = selection?.analysis.playlist ?? parseResolutionPlaylist(await fs.readFile(input, "utf8"));
    const runs: Array<typeof parsed.segments[number][]> = [];
    for (const segment of parsed.segments) {
        if (selection?.keepIndexes && !selection.keepIndexes.has(segment.index)) continue;
        const prior = runs.at(-1)?.at(-1);
        const priorDimensions = prior && selection?.analysis.segments[prior.index];
        const dimensions = selection?.analysis.segments[segment.index];
        const geometryChanged = priorDimensions && dimensions && (priorDimensions.width !== dimensions.width
            || priorDimensions.height !== dimensions.height || priorDimensions.sampleAspectRatio !== dimensions.sampleAspectRatio);
        if (!prior || segment.index !== prior.index + 1 || geometryChanged
            || segment.mapUri !== prior.mapUri || segment.metadata.includes("#EXT-X-DISCONTINUITY")) runs.push([]);
        runs[runs.length - 1].push(segment);
    }
    if (runs.length === 0) throw new Error("Cannot remux an empty selection");
    if (runs.length === 1 && !selection?.keepIndexes) return { args: ["-i", input], cleanup: async () => {} };
    await fs.mkdir(stagingRoot, { recursive: true });
    const temporary = await fs.mkdtemp(path.join(stagingRoot, ".playlist-input-"));
    const cleanup = () => fs.rm(temporary, { recursive: true, force: true });
    const sourceRoot = selection?.analysis.sourceDirectory ?? path.dirname(path.resolve(input));
    try {
        const concat = ["ffconcat version 1.0"];
        for (const [index, run] of runs.entries()) {
            const lines = [...parsed.header];
            if (run[0].mapUri) lines.push(`#EXT-X-MAP:URI="${path.join(sourceRoot, run[0].mapUri)}"`);
            for (const segment of run) {
                lines.push(...segment.metadata.filter((line) => line !== "#EXT-X-DISCONTINUITY"),
                    path.join(sourceRoot, segment.name));
            }
            lines.push("#EXT-X-ENDLIST", "");
            const runPath = path.join(temporary, `${index}.m3u8`);
            await fs.writeFile(runPath, lines.join("\n"), { flag: "wx" });
            concat.push(`file '${runPath.replaceAll("'", "'\\''")}'`,
                `duration ${run.reduce((sum, segment) => sum + segment.durationSeconds, 0).toFixed(9)}`);
        }
        const concatPath = path.join(temporary, "runs.ffconcat");
        await fs.writeFile(concatPath, concat.join("\n") + "\n", { flag: "wx" });
        return { args: ["-f", "concat", "-safe", "0", "-protocol_whitelist", "file,crypto,data", "-i", concatPath], cleanup };
    } catch (error) {
        await cleanup();
        throw error;
    }
}
