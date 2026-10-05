import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { probeNativeStreamLayout, type NativeInputRun } from "./mediaCompatibility.js";
import { productionVideoFilters } from "./videoFilters.js";

async function ffmpeg(args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn("ffmpeg", ["-nostdin", "-hide_banner", "-v", "error", ...args],
            { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-16384); });
        child.once("error", reject);
        child.once("close", code => code === 0 ? resolve()
            : reject(new Error(`Independent-run conversion failed (${code}): ${stderr}`)));
    });
}

// Only the incompatible-input fallback uses this path. Each native run has its
// own demuxer AND decoder; video is encoded exactly once. Intermediate PCM has
// no AAC priming at joins, so final audio is encoded once on a single timeline.
// Missing audio becomes silence; existing A/V offsets are not independently
// reset. Compatible conversions keep the existing copied-audio fast path.
export async function convertIndependentNativeRuns(runs: readonly NativeInputRun[], output: string,
    dimensions: { outputWidth: number; outputHeight: number; rotate?: boolean }): Promise<void> {
    const temporary = await fs.mkdtemp(path.join(path.dirname(output), ".native-conversion-"));
    try {
        const concat = ["ffconcat version 1.0"];
        const hasAudio = runs.some(run => run.layout.some(stream => stream.codec_type === "audio"));
        for (const [index, run] of runs.entries()) {
            const streams = await probeNativeStreamLayout(run.path);
            if (streams.filter(stream => stream.codec_type === "video").length !== 1
                || streams.filter(stream => stream.codec_type === "audio").length > 1) {
                throw new Error("Independent conversion requires one video and at most one audio track");
            }
            const audio = streams.find(stream => stream.codec_type === "audio");
            const videoStart = Number(streams.find(stream => stream.codec_type === "video")?.start_time ?? audio?.start_time);
            if (!Number.isFinite(videoStart)) throw new Error("Cannot establish native video timeline origin");
            const part = path.join(temporary, `${index}.nut`);
            const inputs = ["-fflags", "+genpts", "-copyts", "-i", run.path];
            let filters: string[];
            if (run.pictureless) {
                // No decodable picture in this run: hold the previous run's last
                // frame (black at the very start) for its length; keep its audio.
                const still = path.join(temporary, `${index}.still.png`);
                if (index > 0) await ffmpeg(["-sseof", "-1", "-i", path.join(temporary, `${index - 1}.nut`), "-map", "0:v:0", "-update", "1", still]);
                inputs.push(...(index > 0
                    ? ["-loop", "1", "-framerate", "10", "-t", run.durationSeconds.toFixed(6), "-i", still]
                    : ["-f", "lavfi", "-i", `color=c=black:s=${dimensions.outputWidth}x${dimensions.outputHeight}:r=10:d=${run.durationSeconds.toFixed(6)}`]));
                filters = ["[1:v:0]format=yuv420p,setsar=1[v]"];
            } else {
                filters = [`[0:v:0]setpts=PTS-${videoStart}/TB,${productionVideoFilters(dimensions).join(",")}[v]`];
            }
            if (hasAudio) {
                if (audio) {
                    filters.push(`[0:a:0]asetpts=PTS-${videoStart}/TB,`
                        + `aresample=48000:async=1:first_pts=0,aformat=channel_layouts=stereo,`
                        + `apad,atrim=duration=${run.durationSeconds}[a]`);
                } else {
                    const silence = run.pictureless ? 2 : 1;
                    inputs.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
                    filters.push(`[${silence}:a:0]atrim=duration=${run.durationSeconds},asetpts=PTS-STARTPTS[a]`);
                }
            }
            await ffmpeg([...inputs, "-filter_complex", filters.join(";"), "-map", "[v]",
                ...(hasAudio ? ["-map", "[a]"] : []), "-c:v", "libx264", "-preset", "slow", "-crf", "16",
                "-pix_fmt", "yuv420p", "-fps_mode:v", "vfr", "-enc_time_base:v", "1:90000",
                ...(hasAudio ? ["-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2"] : []), "-f", "nut", part]);
            concat.push(`file '${part.replaceAll("'", "'\\''")}'`, `duration ${run.durationSeconds.toFixed(9)}`);
        }
        const list = path.join(temporary, "converted.ffconcat");
        await fs.writeFile(list, concat.join("\n") + "\n", { flag: "wx" });
        await ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-map", "0:v:0",
            ...(hasAudio ? ["-map", "0:a:0"] : []), "-c:v", "copy",
            ...(hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : []),
            "-video_track_timescale", "90000", "-movflags", "+faststart", "-f", "mp4", output]);
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
