import { promises as fs } from "node:fs";
import path from "node:path";

import type { PipelineConfig } from "../config.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import { inspectFinalizedRecording } from "../discovery/inspectRecording.js";
import { readRecordingFinalization } from "../discovery/recordingFinalization.js";
import { streamCopyRemux } from "../stages/remux.js";
import { containedArtifactPath } from "../stages/remux.js";
import { upscaleTranscode, type UpscaleMode } from "../stages/upscale.js";
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
    readonly artifactMode: "stream-copy" | UpscaleMode;
    readonly videoWidth: number | null;
    readonly videoHeight: number | null;
    readonly sampleAspectRatio: string | null;
    readonly displayAspectRatio: string | null;
    readonly pixelFormat: string | null;
    readonly sourceFrameCount: number | null;
    readonly droppedSourceFrames: number | null;
}

export interface RemuxOneOptions {
    readonly upscaleMode?: UpscaleMode | null;
}

export async function remuxOne(
    requestedPath: string,
    config: PipelineConfig,
    options: RemuxOneOptions = {},
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
        const upscaleMode = options.upscaleMode ?? null;
        if (upscaleMode !== null) {
            // Comparison artifacts are durable named variants, not recording
            // state transitions. The canonical artifact and every downstream
            // upload/description identity remain untouched.
            const transcoded = await upscaleTranscode(
                recording.playlistPath,
                config.stagingRoot,
                recording.id,
                upscaleMode,
            );
            const validated = await validateArtifact(transcoded.path);
            if (validated.videoWidth !== transcoded.plan.outputWidth
                || validated.videoHeight !== transcoded.plan.outputHeight) {
                throw new Error(
                    `${upscaleMode} produced ${validated.videoWidth ?? "unknown"}x${validated.videoHeight ?? "unknown"}; `
                    + `expected ${transcoded.plan.outputWidth}x${transcoded.plan.outputHeight}`,
                );
            }
            if (validated.sampleAspectRatio !== "1:1") {
                throw new Error(`${upscaleMode} output sample aspect ratio is not 1:1`);
            }
            if (validated.pixelFormat !== "yuv420p") {
                throw new Error(`${upscaleMode} output pixel format is not yuv420p`);
            }
            const variant = database.saveArtifactVariant(
                recording.id,
                upscaleMode,
                validated,
                transcoded.plan.sourceFrameCount,
                transcoded.plan.droppedSourceFrames,
            );
            return {
                mode: "single-recording-remux",
                recordingId: recording.id,
                sourcePath: recording.sourcePath,
                authority: "recording-checkpoint",
                state: recording.state,
                artifactPath: variant.path,
                sizeBytes: variant.sizeBytes,
                sha256: variant.sha256,
                durationSeconds: validated.durationSeconds,
                videoCodec: validated.videoCodec,
                audioCodec: validated.audioCodec,
                artifactMode: upscaleMode,
                videoWidth: validated.videoWidth,
                videoHeight: validated.videoHeight,
                sampleAspectRatio: validated.sampleAspectRatio,
                displayAspectRatio: validated.displayAspectRatio,
                pixelFormat: validated.pixelFormat,
                sourceFrameCount: variant.sourceFrameCount,
                droppedSourceFrames: variant.droppedSourceFrames,
            };
        }
        const expectedArtifactPath = containedArtifactPath(config.stagingRoot, recording.id);
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
            if (path.resolve(artifactPath) !== path.resolve(expectedArtifactPath)) {
                throw new Error(
                    `Recording was already materialized with a different artifact mode at ${artifactPath}`,
                );
            }
            validatedArtifact = await validateArtifact(artifactPath);
            recording = database.saveArtifact(recording.id, validatedArtifact);
        }

        const artifact = database.getArtifact(recording.id);
        if (!artifact) {
            throw new Error(`Recording cannot produce an artifact from pipeline state ${recording.state}`);
        }
        if (path.resolve(artifact.path) !== path.resolve(expectedArtifactPath)) {
            throw new Error(`Recording was already materialized with a different artifact mode at ${artifact.path}`);
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
            artifactMode: "stream-copy",
            videoWidth: validated.videoWidth,
            videoHeight: validated.videoHeight,
            sampleAspectRatio: validated.sampleAspectRatio,
            displayAspectRatio: validated.displayAspectRatio,
            pixelFormat: validated.pixelFormat,
            sourceFrameCount: null,
            droppedSourceFrames: null,
        };
    } finally {
        database.close();
    }
}
