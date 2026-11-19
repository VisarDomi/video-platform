// ffmpeg/ffprobe at the lowest CPU priority with two threads, so preparing
// media never competes with anything else on the machine.
import { spawn } from "node:child_process";

export interface ToolOptions {
    ffmpeg?: string;
    ffprobe?: string;
    threads?: number;
}

function run(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn("nice", ["-n", "19", command, ...args], { stdio: ["ignore", "pipe", "pipe"] });
        const out: Buffer[] = [];
        let err = "";
        child.stdout.on("data", chunk => out.push(chunk));
        child.stderr.on("data", chunk => { err = (err + chunk.toString()).slice(-4000); });
        child.on("error", reject);
        child.on("close", code => {
            if (code === 0) resolve(Buffer.concat(out).toString());
            else reject(new Error(`${command} exited with ${code}: ${err.trim()}`));
        });
    });
}

export function ffmpeg(args: string[], options: ToolOptions = {}): Promise<string> {
    return run(options.ffmpeg ?? "ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", ...args]);
}

export async function ffprobeJson(args: string[], options: ToolOptions = {}): Promise<any> {
    return JSON.parse(await run(options.ffprobe ?? "ffprobe", ["-v", "error", "-of", "json", ...args]));
}

export interface StreamFacts {
    video: { codec: string; width: number; height: number; fps: number; profile?: string; level?: number } | null;
    audio: { codec: string } | null;
    durationS: number;
}

function parseRate(rate: string | undefined): number {
    if (!rate) return 0;
    const [n, d] = rate.split("/").map(Number);
    return d ? n / d : n;
}

export async function probe(file: string, options: ToolOptions = {}): Promise<StreamFacts> {
    const info = await ffprobeJson(["-show_streams", "-show_format", file], options);
    const v = info.streams.find((s: any) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
    const a = info.streams.find((s: any) => s.codec_type === "audio");
    return {
        video: v ? {
            codec: v.codec_name, width: v.width, height: v.height,
            fps: parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate),
            profile: v.profile, level: v.level,
        } : null,
        audio: a ? { codec: a.codec_name } : null,
        durationS: Number(info.format?.duration ?? 0),
    };
}

/** Times of the video keyframes in the first `limitS` seconds. */
export async function keyframeTimes(file: string, limitS: number, options: ToolOptions = {}): Promise<number[]> {
    const info = await ffprobeJson([
        "-select_streams", "v:0", "-skip_frame", "nokey", "-show_entries", "frame=pts_time,best_effort_timestamp_time",
        "-read_intervals", `%+${limitS}`, file,
    ], options);
    return (info.frames ?? [])
        .map((f: any) => Number(f.pts_time ?? f.best_effort_timestamp_time))
        .filter((t: number) => Number.isFinite(t));
}
