import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export function buildStreamCopyRemuxArgs(inputPlaylist: string, temporaryOutput: string): string[] {
    return [
        "-nostdin",
        "-hide_banner",
        "-v", "error",
        "-threads", "1",
        "-fflags", "+genpts",
        "-i", inputPlaylist,
        "-map", "0:v?",
        "-map", "0:a?",
        "-c", "copy",
        "-movflags", "+faststart",
        "-f", "mp4",
        temporaryOutput,
    ];
}

export function containedArtifactPath(stagingRoot: string, recordingId: string): string {
    if (!/^[a-f0-9]{64}$/.test(recordingId)) throw new Error("Invalid recording ID for artifact path");
    const resolvedRoot = path.resolve(stagingRoot);
    const artifactPath = path.resolve(resolvedRoot, `${recordingId}.mp4`);
    if (path.dirname(artifactPath) !== resolvedRoot) throw new Error("Artifact path escapes staging root");
    return artifactPath;
}

export async function prepareAtomicRemuxPaths(stagingRoot: string, recordingId: string): Promise<{
    finalPath: string;
    temporaryPath: string;
}> {
    const finalPath = containedArtifactPath(stagingRoot, recordingId);
    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    return {
        finalPath,
        temporaryPath: `${finalPath}.${randomUUID()}.partial.mp4`,
    };
}

export async function streamCopyRemux(
    inputPlaylist: string,
    stagingRoot: string,
    recordingId: string,
): Promise<string> {
    const { finalPath, temporaryPath } = await prepareAtomicRemuxPaths(stagingRoot, recordingId);
    const existing = await fs.lstat(finalPath).catch(() => null);
    if (existing?.isFile()) return finalPath;
    if (existing) throw new Error(`Refusing to replace non-file artifact path ${finalPath}`);
    try {
        await new Promise<void>((resolve, reject) => {
            const child = spawn("ffmpeg", buildStreamCopyRemuxArgs(path.resolve(inputPlaylist), temporaryPath), {
                stdio: ["ignore", "ignore", "pipe"],
            });
            let stderr = "";
            child.stderr.on("data", (chunk: Buffer) => {
                stderr = `${stderr}${chunk.toString()}`.slice(-16_384);
            });
            child.once("error", reject);
            child.once("close", (code) => {
                if (code === 0) resolve();
                else reject(new Error(`ffmpeg stream-copy remux failed (${code ?? "unknown"}): ${stderr.trim()}`));
            });
        });
        try {
            await fs.link(temporaryPath, finalPath);
        } catch (error) {
            const raced = await fs.lstat(finalPath).catch(() => null);
            if (!raced?.isFile()) throw error;
        }
        await fs.unlink(temporaryPath);
        return finalPath;
    } catch (error) {
        await fs.unlink(temporaryPath).catch(() => undefined);
        throw error;
    }
}
