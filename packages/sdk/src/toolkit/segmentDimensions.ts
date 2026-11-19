import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SegmentDimensions } from "../capture.js";

const execFileAsync = promisify(execFile);

// The video geometry of an MPEG-TS segment, read with ffprobe. For boundary tracking
// only: null (unknown) never rejects media, the core keeps the segment with a boundary
// on each side.
export async function probeSegmentDimensions(filePath: string): Promise<SegmentDimensions | null> {
    try {
        const { stdout } = await execFileAsync("ffprobe", [
            "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height,sample_aspect_ratio", "-of", "json", filePath,
        ], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5000 });
        const stream = JSON.parse(stdout).streams?.[0];
        if (!Number.isSafeInteger(stream?.width) || stream.width <= 0
            || !Number.isSafeInteger(stream?.height) || stream.height <= 0) return null;
        return { width: stream.width, height: stream.height,
            sampleAspectRatio: stream.sample_aspect_ratio && stream.sample_aspect_ratio !== "N/A"
                ? stream.sample_aspect_ratio : "1:1" };
    } catch {
        return null;
    }
}
