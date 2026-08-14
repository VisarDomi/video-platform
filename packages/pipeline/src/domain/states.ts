export const PIPELINE_STATES = [
    "server_ready",
    "remuxed",
    "artifact_valid",
    "described",
    "provenance_review_required",
    "metadata_ready",
    "oldhost_admitted",
    "oldhost_uploading",
    "oldhost_uploaded",
    "oldhost_uncertain",
    "oldhost_verified",
    "cleanup_eligible",
    "blocked",
    "failed",
] as const;

export type PipelineState = typeof PIPELINE_STATES[number];

const ALLOWED_TRANSITIONS: Readonly<Record<PipelineState, readonly PipelineState[]>> = {
    server_ready: ["remuxed", "blocked", "failed"],
    remuxed: ["artifact_valid", "blocked", "failed"],
    artifact_valid: ["described", "blocked", "failed"],
    described: ["provenance_review_required", "metadata_ready", "blocked", "failed"],
    provenance_review_required: ["described", "blocked", "failed"],
    metadata_ready: ["oldhost_admitted", "blocked", "failed"],
    oldhost_admitted: ["oldhost_uploading", "metadata_ready", "blocked", "failed"],
    oldhost_uploading: ["oldhost_uploaded", "oldhost_uncertain", "metadata_ready", "failed"],
    oldhost_uploaded: ["oldhost_verified", "oldhost_uncertain", "failed"],
    oldhost_uncertain: ["oldhost_uploaded", "metadata_ready", "failed"],
    oldhost_verified: ["cleanup_eligible", "failed"],
    cleanup_eligible: [],
    blocked: [],
    failed: ["server_ready", "remuxed", "artifact_valid", "described", "metadata_ready"],
};

export function assertTransition(from: PipelineState, to: PipelineState): void {
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
        throw new Error(`Invalid pipeline transition: ${from} -> ${to}`);
    }
}
