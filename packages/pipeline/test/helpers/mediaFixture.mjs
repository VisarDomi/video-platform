import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

export const exec = promisify(execFile);
export async function fixturePart(root, name, { size = "320x180", offset = 0, frames = 6, gop = 6, fmp4 = false, timestampOffset = 0 } = {}) {
    const folder = path.join(root, name);
    await mkdir(folder, { recursive: true });
    const input = path.join(folder, fmp4 ? "playlist.m3u8" : "segment.ts");
    // Each frame has a distinct luma ID. B-frames exercise delayed decoder output.
    await exec("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", `nullsrc=size=${size}:rate=10,geq=lum='30+${offset}+N*8':cb=128:cr=128`,
        "-f", "lavfi", "-i", `sine=frequency=${440 + offset * 10}:sample_rate=48000`,
        "-t", String(frames / 10), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10",
        "-bf", "2", "-g", String(gop), "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-c:a", "aac",
        ...(fmp4 ? ["-f", "hls", "-hls_segment_type", "fmp4", "-hls_time", "100", "-hls_list_size", "0",
            "-hls_fmp4_init_filename", "init.mp4", "-hls_segment_filename", path.join(folder, "segment%d.m4s")]
            : ["-f", "mpegts", "-output_ts_offset", String(timestampOffset)]), input]);
    return { input, folder, size, frames };
}

export async function assemble(root, parts, durations = parts.map((p) => p.frames / 10)) {
    const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:10"];
    for (const [i, part] of parts.entries()) {
        if (i) lines.push("#EXT-X-DISCONTINUITY");
        // Keep files directly under root, like production playlists require.
        const stem = `part-${i}`;
        if (part.input.endsWith("m3u8")) {
            await writeFile(path.join(root, `${stem}.mp4`), await readFile(path.join(part.folder, "init.mp4")));
            await writeFile(path.join(root, `${stem}.ts`), await readFile(path.join(part.folder, "segment0.m4s")));
            lines.push(`#EXT-X-MAP:URI="${stem}.mp4"`);
        } else await writeFile(path.join(root, `${stem}.ts`), await readFile(part.input));
        lines.push(`#EXTINF:${durations[i]},`, `${stem}.ts`);
    }
    lines.push("#EXT-X-ENDLIST", "");
    const playlist = path.join(root, "playlist.m3u8");
    await writeFile(playlist, lines.join("\n"));
    return playlist;
}

export async function frameIds(input) {
    const { stdout } = await exec("ffmpeg", ["-nostdin", "-v", "error", "-i", input,
        "-map", "0:v:0", "-vf", "scale=1:1:flags=area,format=gray", "-fps_mode", "passthrough",
        "-f", "rawvideo", "pipe:1"], { encoding: "buffer", maxBuffer: 1024 * 1024 });
    return [...stdout];
}

export async function videoTimes(input) {
    const { stdout } = await exec("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_frames",
        "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", input]);
    return JSON.parse(stdout).frames.map((f) => Number(f.best_effort_timestamp_time));
}

export async function videoSliceHashes(input) {
    const { stdout } = await exec("ffmpeg", ["-nostdin", "-v", "error", "-i", input, "-map", "0:v:0",
        "-c:v", "copy", "-bsf:v", "h264_mp4toannexb", "-f", "h264", "pipe:1"],
        { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
    const starts = [];
    for (let i = 0; i + 3 < stdout.length; i++) {
        if (stdout[i] === 0 && stdout[i + 1] === 0 && stdout[i + 2] === 1) starts.push(i + 3);
    }
    const hashes = [];
    for (let i = 0; i < starts.length; i++) {
        const type = stdout[starts[i]] & 31;
        if (type < 1 || type > 5) continue; // SPS/PPS framing may change on remux; encoded picture slices must not.
        let end = i + 1 < starts.length ? starts[i + 1] - 3 : stdout.length;
        while (end > starts[i] && stdout[end - 1] === 0) end--;
        hashes.push(createHash("sha256").update(stdout.subarray(starts[i], end)).digest("hex"));
    }
    return hashes;
}

export async function audioPackets(input) {
    // Normalize ADTS framing to MP4 before hashing: stream-copy changes the
    // transport header, not the AAC payload. Compare payloads, not TS headers.
    if (input.endsWith(".ts")) {
        const normalized = `${input}.audio.m4a`;
        await exec("ffmpeg", ["-nostdin", "-v", "error", "-i", input, "-map", "0:a:0",
            "-c:a", "copy", "-y", normalized]);
        input = normalized;
    }
    const { stdout } = await exec("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_packets",
        "-show_data_hash", "sha256", "-show_entries", "packet=data_hash,pts_time,duration_time", "-of", "json", input]);
    return JSON.parse(stdout).packets;
}
