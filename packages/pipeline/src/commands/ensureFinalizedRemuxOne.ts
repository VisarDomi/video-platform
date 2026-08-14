import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import type { PipelineConfig } from "../config.js";
import { readRecordingFinalization } from "../discovery/recordingFinalization.js";
import { remuxOne } from "./remuxOne.js";

function serverFinalizerEntrypoint(): string {
    return path.resolve(
        import.meta.dirname,
        "..", "..", "..", "server", "dist", "commands", "finalizeLibrary.js",
    );
}

async function hasExactCheckpoint(recordingPath: string, config: PipelineConfig): Promise<boolean> {
    try {
        const playlist = await readFile(path.join(recordingPath, "playlist.m3u8"), "utf8");
        return readRecordingFinalization(config.finalizationDatabasePath, recordingPath, playlist) !== null;
    } catch {
        return false;
    }
}

async function finalizeExactRecording(recordingPath: string): Promise<void> {
    const entrypoint = serverFinalizerEntrypoint();
    await access(entrypoint).catch(() => {
        throw new Error("Server finalizer is not built; run npm run build -w server first");
    });
    await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [
            "--no-warnings",
            entrypoint,
            "--recording", recordingPath,
            "--apply",
            "--concurrency", "1",
            "--max-cpu", "80",
        ], { stdio: "inherit" });
        child.once("error", reject);
        child.once("close", (code, signal) => {
            if (code === 0) resolve();
            else reject(new Error(`Server finalization failed (${signal ?? code ?? "unknown"})`));
        });
    });
}

export async function ensureFinalizedRemuxOne(requestedPath: string, config: PipelineConfig) {
    const recordingPath = path.resolve(requestedPath);
    const root = config.manualRemuxRoots.find((candidate) => path.resolve(candidate.path) === path.dirname(recordingPath));
    if (!root || path.basename(recordingPath).startsWith(".")) {
        throw new Error("--recording must be one visible immediate child of a managed downloader or edited root");
    }
    let finalizedNow = false;
    if (!await hasExactCheckpoint(recordingPath, config)) {
        await finalizeExactRecording(recordingPath);
        finalizedNow = true;
    }
    if (!await hasExactCheckpoint(recordingPath, config)) {
        throw new Error("Server finalization completed without a matching ready checkpoint");
    }
    return { finalizedNow, ...await remuxOne(recordingPath, config) };
}
