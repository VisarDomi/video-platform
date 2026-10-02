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
    server_ready: ["remuxed", "artifact_valid", "blocked", "failed", "cleanup_eligible", "oldhost_uncertain"],
    remuxed: ["artifact_valid", "blocked", "failed", "cleanup_eligible", "oldhost_uncertain"],
    artifact_valid: ["described", "blocked", "failed", "cleanup_eligible", "oldhost_uncertain"],
    described: ["provenance_review_required", "metadata_ready", "blocked", "failed", "cleanup_eligible", "oldhost_uncertain"],
    provenance_review_required: ["described", "blocked", "failed", "cleanup_eligible", "oldhost_uncertain"],
    metadata_ready: ["oldhost_admitted", "artifact_valid", "blocked", "failed", "cleanup_eligible", "oldhost_uncertain"],
    oldhost_admitted: ["oldhost_uploading", "metadata_ready", "blocked", "failed", "cleanup_eligible"],
    oldhost_uploading: ["oldhost_uploaded", "oldhost_uncertain", "metadata_ready", "blocked", "failed", "cleanup_eligible"],
    oldhost_uploaded: ["artifact_valid", "oldhost_verified", "oldhost_uncertain", "blocked", "failed", "cleanup_eligible"],
    oldhost_uncertain: ["oldhost_uploaded", "metadata_ready", "blocked", "failed", "cleanup_eligible"],
    oldhost_verified: ["cleanup_eligible", "failed"],
    cleanup_eligible: [],
    blocked: ["server_ready", "remuxed", "artifact_valid", "described", "metadata_ready"],
    failed: ["server_ready", "remuxed", "artifact_valid", "described", "metadata_ready"],
};

export function assertTransition(from: PipelineState, to: PipelineState): void {
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
        throw new Error(`Invalid pipeline transition: ${from} -> ${to}`);
    }
}
