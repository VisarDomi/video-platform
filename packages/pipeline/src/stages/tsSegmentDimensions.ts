import { spawn } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import type { VideoDimensions } from "./resolutionPolicy.js";

export interface TsDimensionScan {
    // Per playlist position; null when no independently decodable keyframe was found.
    readonly dimensions: Array<VideoDimensions | null>;
    // Positions of zero-byte files: no media, never fed to the probe or encoder.
    readonly empty: ReadonlySet<number>;
    readonly warnings: readonly string[];
}

// Feed the TS bytes in PLAYLIST order through one probe. Packet byte positions
// identify the owning segment even when timestamps reset, filenames repeat, or
// GOP/keyframe counts differ. Never infer ownership from frame-count division.
// Nothing here rejects a segment: odd sizes and size changes inside a segment
// are reported, and the larger picture of such a segment is its measurement.
export async function probeTsSegmentDimensions(paths: readonly string[]): Promise<TsDimensionScan> {
    const empty = new Set<number>();
    const warnings: string[] = [];
    const scanned: number[] = [];
    const boundaries: number[] = [0];
    for (const [position, input] of paths.entries()) {
        const stat = await fs.stat(input);
        if (!stat.isFile()) throw new Error(`Segment is not a regular file: ${input}`);
        if (stat.size === 0) {
            empty.add(position);
            continue;
        }
        if (stat.size % 188 !== 0) warnings.push(`segment ${input} is not a whole number of 188-byte MPEG-TS packets`);
        scanned.push(position);
        boundaries.push(boundaries[boundaries.length - 1] + stat.size);
    }
    const dimensions: Array<VideoDimensions | null> = new Array(paths.length).fill(null);
    if (!scanned.length) return { dimensions, empty, warnings };
    const changed = new Set<number>();
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
            if (!Number.isSafeInteger(position) || position < 0 || position >= boundaries[scanned.length]) {
                throw new Error("MPEG-TS frame has no usable packet position; cannot establish segment ownership");
            }
            let left = 0;
            let right = scanned.length;
            while (left + 1 < right) {
                const middle = (left + right) >>> 1;
                if (boundaries[middle] <= position) left = middle;
                else right = middle;
            }
            const owner = scanned[left];
            const next = { width: Number(fields.width), height: Number(fields.height),
                sampleAspectRatio: fields.sample_aspect_ratio ?? null };
            if (![next.width, next.height].every((n) => Number.isSafeInteger(n) && n > 0)) return;
            const prior = dimensions[owner];
            if (prior && (prior.width !== next.width || prior.height !== next.height
                || prior.sampleAspectRatio !== next.sampleAspectRatio)) {
                changed.add(owner);
                if (next.width * next.height <= prior.width * prior.height) return;
            }
            dimensions[owner] = next;
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
        for (const [order, position] of scanned.entries()) {
            let size = 0;
            for await (const chunk of createReadStream(paths[position])) {
                size += chunk.length;
                yield chunk;
            }
            if (size !== boundaries[order + 1] - boundaries[order]) {
                throw new Error(`MPEG-TS segment changed during scan: ${paths[position]}`);
            }
        }
    }
    try {
        await Promise.all([exited, pipeline(bytes(), child.stdin)]);
        if (parseError) throw parseError;
        for (const position of changed) {
            warnings.push(`picture size changes inside segment ${paths[position]}; measured by its largest picture`);
        }
        return { dimensions, empty, warnings };
    } catch (error) {
        throw parseError ?? error;
    } finally {
        lines.close();
        child.kill();
    }
}
