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

export type ProvenanceResolutionStatus = "resolved" | "review_required" | "manual";

export interface RecordingProvenance {
    readonly recordingId: string;
    readonly observedIdentifier: string;
    readonly status: ProvenanceResolutionStatus;
    readonly streamerId: string | null;
    readonly alias: string | null;
    readonly streamerUrl: string | null;
    readonly aliasUrl: string | null;
    readonly reason: string | null;
    readonly updatedAt: string;
}

export interface DescriptionRecord {
    readonly recordingId: string;
    readonly artifactSha256: string;
    readonly promptVersion: string;
    readonly fps: number;
    readonly output: unknown;
    readonly evidencePath: string;
    readonly createdAt: string;
}

export interface UploadMetadataRecord {
    readonly recordingId: string;
    readonly title: string;
    readonly description: string;
    readonly tags: readonly string[];
    readonly createdAt: string;
}

export interface UploadConfirmation {
    readonly attemptId: string;
    readonly recordingId: string;
    readonly confirmAfter: string;
    readonly status: "pending" | "found" | "absent";
    readonly checkedAt: string | null;
}

export type CampaignProviderFilter = "all" | "tango" | "fc2" | "sc";

export interface CampaignControl {
    readonly state: "paused" | "running";
    readonly providerFilter: CampaignProviderFilter;
    readonly ordering: "oldest";
    readonly monthlyUploadLimitBytes: number;
    readonly updatedAt: string;
}
