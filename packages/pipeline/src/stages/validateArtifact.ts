import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";

export interface ValidatedArtifact {
    readonly path: string;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly durationSeconds: number;
    readonly videoCodec: string | null;
    readonly audioCodec: string | null;
    readonly validatedAt: string;
}

interface ProbeOutput {
    format?: { duration?: string; format_name?: string };
    streams?: Array<{ codec_type?: string; codec_name?: string }>;
}

async function run(command: string, args: readonly string[]): Promise<string> {
    return await new Promise((resolve, reject) => {
        const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-16_384); });
        child.once("error", reject);
        child.once("close", (code) => {
            if (code === 0) resolve(stdout);
            else reject(new Error(`${command} validation failed (${code ?? "unknown"}): ${stderr.trim()}`));
        });
    });
}

async function sha256(filePath: string): Promise<string> {
    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(filePath);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.once("error", reject);
        stream.once("end", resolve);
    });
    return hash.digest("hex");
}

export async function validateArtifact(artifactPath: string, now = new Date()): Promise<ValidatedArtifact> {
    const resolvedPath = path.resolve(artifactPath);
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile() || stats.size <= 0) throw new Error("Artifact must be a nonempty regular file");

    const probe = JSON.parse(await run("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration,format_name:stream=codec_type,codec_name",
        "-of", "json",
        resolvedPath,
    ])) as ProbeOutput;
    const durationSeconds = Number.parseFloat(probe.format?.duration ?? "");
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("Artifact has no positive duration");
    if (!probe.format?.format_name?.split(",").includes("mp4")) throw new Error("Artifact is not an MP4 container");
    const videoCodec = probe.streams?.find((stream) => stream.codec_type === "video")?.codec_name ?? null;
    const audioCodec = probe.streams?.find((stream) => stream.codec_type === "audio")?.codec_name ?? null;
    if (!videoCodec && !audioCodec) throw new Error("Artifact has neither a video nor audio stream");

    await run("ffmpeg", [
        "-nostdin", "-hide_banner", "-v", "error",
        "-i", resolvedPath,
        "-map", "0:v?", "-map", "0:a?", "-f", "null", "-",
    ]);

    return {
        path: resolvedPath,
        sizeBytes: stats.size,
        sha256: await sha256(resolvedPath),
        durationSeconds,
        videoCodec,
        audioCodec,
        validatedAt: now.toISOString(),
    };
}
