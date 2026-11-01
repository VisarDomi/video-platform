import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import pLimit from "p-limit";

export interface DisplaySize { width: number; height: number }
export interface MediaMetadata extends Partial<DisplaySize> { duration: number }
const execute = promisify(execFile);
const probes = pLimit(2);

// Display pixels, including non-square pixels and track rotation. Encoded dimensions
// alone would reserve the wrong rectangle for rotated phone movies.
export function displaySize(stream: any): DisplaySize | undefined {
    let width = Number(stream?.width), height = Number(stream?.height);
    if (![width, height].every(n => Number.isFinite(n) && n > 0 && n <= 100_000)) return;
    const sar = String(stream.sample_aspect_ratio ?? "1:1").split(":").map(Number);
    if (sar.length === 2 && sar.every(n => Number.isFinite(n) && n > 0)) width *= sar[0] / sar[1];
    const rotation = Number(stream.side_data_list?.find((row: any) => Number.isFinite(Number(row.rotation)))?.rotation ?? stream.tags?.rotate ?? 0);
    if (Number.isFinite(rotation)) {
        const angle = rotation * Math.PI / 180, cosine = Math.abs(Math.cos(angle)), sine = Math.abs(Math.sin(angle));
        [width, height] = [width * cosine + height * sine, width * sine + height * cosine];
    }
    return { width: Math.round(width * 1000) / 1000, height: Math.round(height * 1000) / 1000 };
}

export async function mediaMetadata(file: string, active = () => true): Promise<MediaMetadata> {
    return probes(async () => {
        if (!active()) return { duration: 0 };
        const { stdout } = await execute("ffprobe", ["-v", "error", "-protocol_whitelist", "file,crypto,data", "-analyzeduration", "1000000", "-probesize", "1000000",
            "-select_streams", "v:0", "-show_entries", "format=duration:stream=width,height,sample_aspect_ratio:stream_tags=rotate:stream_side_data=rotation",
            "-of", "json", ...(path.extname(file).toLowerCase() === ".m3u8" ? ["-allowed_extensions", "ALL"] : []), file], { timeout: 15_000, maxBuffer: 128 * 1024 });
        const data = JSON.parse(stdout), duration = Number(data.format?.duration);
        return { duration: Number.isFinite(duration) && duration >= 0 ? duration : 0, ...displaySize(data.streams?.[0]) };
    });
}

export async function recordingDisplaySize(directory: string, active = () => true): Promise<DisplaySize | undefined> {
    const playlist = path.join(directory, "playlist.m3u8");
    const text = await fs.readFile(playlist, "utf8");
    // Fragmented MP4 needs its EXT-X-MAP init bytes; encrypted HLS needs its key/IV.
    // Passing a fragment alone loses that context and cannot expose video dimensions.
    if (/#EXT-X-(?:MAP|KEY):/.test(text)) {
        const metadata = await mediaMetadata(playlist, active);
        return metadata.width && metadata.height ? { width: metadata.width, height: metadata.height } : undefined;
    }
    // Read a local segment header, never the whole recording or a network URL.
    const files = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
    for (const name of files.slice(0, 8)) {
        if (!active()) return;
        const file = path.resolve(directory, name);
        if (path.dirname(file) !== path.resolve(directory)) continue;
        const stat = await fs.stat(file).catch(() => undefined);
        if (!stat?.isFile() || stat.size <= 0) continue;
        try {
            const size = await mediaMetadata(file, active);
            if (size.width && size.height) return { width: size.width, height: size.height };
        } catch { /* An active/partial segment may not have its video header yet. */ }
    }
}
