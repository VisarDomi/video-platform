import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

async function capture(command: string, args: string[]): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) resolve(stdout);
            else reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
        });
    });
}

export async function probeDuration(mediaPath: string): Promise<number> {
    const stdout = await capture("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        mediaPath,
    ]);
    const duration = Number.parseFloat(stdout.trim());
    if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error(`ffprobe returned no positive duration for ${mediaPath}`);
    }
    return duration;
}

export function chooseVideoFps(
    durationSeconds: number,
    videoTokenBudget: number,
    tokensPerFrame: number,
    maximumFps: number,
): number {
    const inputs = { durationSeconds, videoTokenBudget, tokensPerFrame, maximumFps };
    for (const [name, value] of Object.entries(inputs)) {
        if (!Number.isFinite(value) || value <= 0) {
            throw new Error(`${name} must be a positive finite number`);
        }
    }
    const durationCeiling = durationSeconds < 7 * 60
        ? 4
        : durationSeconds < 15 * 60
            ? 2
            : 1;
    const budgetedFps = videoTokenBudget / tokensPerFrame / durationSeconds;
    return Math.min(maximumFps, durationCeiling, budgetedFps);
}

// The pipeline turns portrait recordings 90° counterclockwise for upload. The
// model reads people lying on their side in those, so it gets a copy turned
// back clockwise, sampled at the descriptor's maximum frame rate (it never
// samples more densely, so it sees the same moments).
export async function makeUprightCopy(mediaPath: string, mediaDirectory: string, fps: number) {
    await fs.mkdir(mediaDirectory, { recursive: true });
    const uprightPath = path.join(mediaDirectory, `${randomUUID()}.upright.mp4`);
    const remove = async () => { await fs.unlink(uprightPath).catch(() => undefined); };
    try {
        await capture("ffmpeg", [
            "-nostdin", "-hide_banner", "-v", "error", "-i", mediaPath,
            "-map", "0:v:0", "-map", "0:a?", "-vf", `transpose=1,fps=${fps}`,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
            "-c:a", "copy", "-movflags", "+faststart", "-f", "mp4", uprightPath,
        ]);
    } catch (error) {
        await remove();
        throw error;
    }
    return { path: uprightPath, remove };
}

export async function stageMedia(mediaPath: string, mediaDirectory: string) {
    await fs.mkdir(mediaDirectory, { recursive: true });
    const stagedName = `${randomUUID()}${path.extname(mediaPath).toLowerCase() || ".mp4"}`;
    const stagedPath = path.join(mediaDirectory, stagedName);
    await fs.symlink(mediaPath, stagedPath);
    return {
        url: `file://${stagedName}`,
        remove: async () => { await fs.unlink(stagedPath).catch(() => undefined); },
    };
}
