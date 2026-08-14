import { promises as fs } from "node:fs";
import path from "node:path";

import type { PipelineConfig } from "../config.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import { inspectFinalizedRecording } from "../discovery/inspectRecording.js";
import { readRecordingFinalization } from "../discovery/recordingFinalization.js";
import { streamCopyRemux } from "../stages/remux.js";
import { validateArtifact, type ValidatedArtifact } from "../stages/validateArtifact.js";

export interface RemuxOneResult {
    readonly mode: "single-recording-remux";
    readonly recordingId: string;
    readonly sourcePath: string;
    readonly authority: "recording-checkpoint";
    readonly state: string;
    readonly artifactPath: string;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly durationSeconds: number;
    readonly videoCodec: string | null;
    readonly audioCodec: string | null;
}

export async function remuxOne(
    requestedPath: string,
    config: PipelineConfig,
): Promise<RemuxOneResult> {
    const sourcePath = path.resolve(requestedPath);
    const root = config.manualRemuxRoots.find(
        (candidate) => path.resolve(candidate.path) === path.dirname(sourcePath),
    );
    if (!root || path.basename(sourcePath).startsWith(".")) {
        throw new Error("--recording must be one visible immediate child of a managed downloader or edited root");
    }
    const stats = await fs.lstat(sourcePath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error("--recording must be a directly owned recording directory, not a symlink");
    }

    const inspection = await inspectFinalizedRecording(sourcePath, root.provider, root.sourceKind);
    if (inspection.status !== "finalized") {
        throw new Error(`Recording is not remuxable: ${inspection.reason}`);
    }
    const playlistContent = await fs.readFile(inspection.recording.playlistPath, "utf8");
    const recordingAuthority = readRecordingFinalization(
        config.finalizationDatabasePath,
        sourcePath,
        playlistContent,
    );
    if (!recordingAuthority) {
        throw new Error("Recording has no matching successful server checkpoint");
    }

    const database = new PipelineDatabase(config.databasePath);
    try {
        let recording = database.discover(inspection.recording);
        let validatedArtifact: ValidatedArtifact | null = null;
        if (recording.state === "server_ready") {
            const artifactPath = await streamCopyRemux(
                recording.playlistPath,
                config.stagingRoot,
                recording.id,
            );
            recording = database.saveRemuxOutput(recording.id, artifactPath);
        }
        if (recording.state === "remuxed") {
            const artifactPath = database.getRemuxOutput(recording.id);
            if (!artifactPath) throw new Error("Remuxed recording has no durable artifact path");
            validatedArtifact = await validateArtifact(artifactPath);
            recording = database.saveArtifact(recording.id, validatedArtifact);
        }

        const artifact = database.getArtifact(recording.id);
        if (!artifact) {
            throw new Error(`Recording cannot produce an artifact from pipeline state ${recording.state}`);
        }
        const validated = validatedArtifact ?? await validateArtifact(artifact.path);
        if (validated.sha256 !== artifact.sha256) {
            throw new Error("Existing artifact hash no longer matches its durable pipeline record");
        }
        return {
            mode: "single-recording-remux",
            recordingId: recording.id,
            sourcePath: recording.sourcePath,
            authority: "recording-checkpoint",
            state: recording.state,
            artifactPath: artifact.path,
            sizeBytes: artifact.sizeBytes,
            sha256: artifact.sha256,
            durationSeconds: validated.durationSeconds,
            videoCodec: validated.videoCodec,
            audioCodec: validated.audioCodec,
        };
    } finally {
        database.close();
    }
}
