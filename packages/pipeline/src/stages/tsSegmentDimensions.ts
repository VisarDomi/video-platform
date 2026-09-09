import { spawn } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import type { VideoDimensions } from "./resolutionPolicy.js";

// Feed the TS bytes in PLAYLIST order through one probe. Packet byte positions
// identify the owning segment even when timestamps reset, filenames repeat, or
// GOP/keyframe counts differ. Never infer ownership from frame-count division.
export async function probeTsSegmentDimensions(paths: readonly string[]): Promise<VideoDimensions[]> {
    const boundaries: number[] = [0];
    for (const input of paths) {
        const stat = await fs.stat(input);
        if (!stat.isFile() || stat.size <= 0 || stat.size % 188 !== 0) {
            throw new Error(`Expected a nonempty 188-byte MPEG-TS segment: ${input}`);
        }
        boundaries.push(boundaries[boundaries.length - 1] + stat.size);
    }
    const dimensions: Array<VideoDimensions | undefined> = new Array(paths.length);
    const child = spawn("ffprobe", [
        "-v", "error", "-f", "mpegts", "-skip_frame", "nokey", "-select_streams", "v:0",
        "-show_frames", "-show_entries", "frame=pkt_pos,width,height,sample_aspect_ratio",
        "-of", "compact=p=0:nk=0", "pipe:0",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let parseError: Error | undefined;
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
        if (parseError || !line.includes("width=")) return;
        try {
            const fields = Object.fromEntries(line.split("|").map((field) => field.split("=", 2)));
            const position = Number(fields.pkt_pos);
            if (!Number.isSafeInteger(position) || position < 0 || position >= boundaries[paths.length]) {
                throw new Error("MPEG-TS frame has no usable packet position; cannot establish segment ownership");
            }
            let left = 0;
            let right = paths.length;
            while (left + 1 < right) {
                const middle = (left + right) >>> 1;
                if (boundaries[middle] <= position) left = middle;
                else right = middle;
            }
            const next = { width: Number(fields.width), height: Number(fields.height),
                sampleAspectRatio: fields.sample_aspect_ratio ?? null };
            if (![next.width, next.height].every((n) => Number.isSafeInteger(n) && n > 0)) {
                throw new Error(`Invalid MPEG-TS dimensions in ${paths[left]}`);
            }
            const prior = dimensions[left];
            if (prior && (prior.width !== next.width || prior.height !== next.height
                || prior.sampleAspectRatio !== next.sampleAspectRatio)) {
                throw new Error(`MPEG-TS dimensions/aspect change inside segment ${paths[left]}; cannot classify safely`);
            }
            dimensions[left] = next;
        } catch (error) {
            parseError = error instanceof Error ? error : new Error(String(error));
            child.kill();
        }
    });
    const exited = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => code === 0 ? resolve()
            : reject(parseError ?? new Error(`MPEG-TS position scan failed (${code}): ${stderr.trim()}`)));
    });
    async function* bytes() {
        for (let index = 0; index < paths.length; index++) {
            let size = 0;
            for await (const chunk of createReadStream(paths[index])) {
                size += chunk.length;
                yield chunk;
            }
            if (size !== boundaries[index + 1] - boundaries[index]) {
                throw new Error(`MPEG-TS segment changed during scan: ${paths[index]}`);
            }
        }
    }
    try {
        await Promise.all([exited, pipeline(bytes(), child.stdin)]);
        if (parseError) throw parseError;
        return paths.map((input, index) => {
            const result = dimensions[index];
            if (!result) throw new Error(`No independently decodable keyframe in MPEG-TS segment ${input}`);
            return result;
        });
    } catch (error) {
        throw parseError ?? error;
    } finally {
        lines.close();
        child.kill();
    }
}
