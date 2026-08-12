import type { PipelineState } from "./states.js";

export type SourceKind = "downloader" | "edited";

export interface RecordingInput {
    readonly provider: string;
    readonly sourceKind: SourceKind;
    readonly sourcePath: string;
    readonly playlistPath: string;
    readonly sourceFingerprint: string;
    readonly durationSeconds: number;
}

export interface Recording extends RecordingInput {
    readonly id: string;
    readonly state: PipelineState;
    readonly blockReason: string | null;
    readonly leaseOwner: string | null;
    readonly leaseExpiresAt: string | null;
    readonly attemptCount: number;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface ArtifactRecord {
    readonly recordingId: string;
    readonly path: string;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly validatedAt: string;
}
