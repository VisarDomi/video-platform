import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import type { PipelineConfig } from "../config.js";
import { readXvideosCredentials } from "../config/secrets.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import { inspectFinalizedRecording } from "../discovery/inspectRecording.js";
import { readRecordingFinalization } from "../discovery/recordingFinalization.js";
import { ChromiumXvideosUploader } from "../upload/chromiumXvideosUploader.js";
import { guardUploadIdentity, refusalMessage } from "./uploadIdentityGuard.js";
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
    // Never start remux/finalization work on a recording that is already on
    // XVideos: the ledger identity (edit ID) is the single source of truth.
    const identityDatabase = new PipelineDatabase(config.databasePath);
    try {
        const existing = identityDatabase.findRecordingByBasename(root.provider, path.basename(recordingPath));
        if (existing) {
            const outcome = await guardUploadIdentity(identityDatabase, existing, config);
            if (outcome.kind === "verified_cleaned") {
                return {
                    mode: "single-recording-remux",
                    recordingId: existing.id,
                    sourcePath: recordingPath,
                    disposition: "already_verified_cleaned",
                    state: identityDatabase.get(existing.id)?.state,
                    remoteId: outcome.remoteId,
                };
            }
            if (outcome.kind === "unverified_refused") {
                throw new Error(refusalMessage(outcome));
            }
        }
    } finally {
        identityDatabase.close();
    }
    // Admission-time remote check: the folder name is the local truth, the
    // edit-page title is the XVideos truth.
    if (config.networkUploadsEnabled) {
        const credentials = await readXvideosCredentials(config.credentialsFilePath);
        const uploader = new ChromiumXvideosUploader({
            executablePath: config.chromiumExecutablePath,
            profilePath: config.browserProfilePath,
            ...credentials,
        });
        const folderName = path.basename(recordingPath);
        const copy = await uploader.findUploadedCopy(folderName);
        if (copy.kind === "found" || copy.kind === "title_mismatch") {
            const database = new PipelineDatabase(config.databasePath);
            try {
                const inspection = await inspectFinalizedRecording(recordingPath, root.provider, root.sourceKind);
                if (inspection.status !== "finalized") {
                    throw new Error(`Recording is not remuxable: ${inspection.reason}`);
                }
                const recording = database.discover(inspection.recording);
                if (copy.kind === "found") {
                    database.parkUploadedCopy(recording.id, copy.remoteId, copy.remoteUrl);
                    return {
                        mode: "single-recording-remux",
                        recordingId: recording.id,
                        sourcePath: recordingPath,
                        disposition: "parked_existing_upload",
                        remoteId: copy.remoteId,
                        state: database.get(recording.id)?.state,
                    };
                }
                database.transition(recording.id, recording.state, "blocked",
                    `XVideos entry ${copy.remoteId} title does not match the folder identity; manual review required`);
                return {
                    mode: "single-recording-remux",
                    recordingId: recording.id,
                    sourcePath: recordingPath,
                    disposition: "manual_review",
                    remoteId: copy.remoteId,
                    state: "blocked",
                };
            } finally {
                database.close();
            }
        }
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
