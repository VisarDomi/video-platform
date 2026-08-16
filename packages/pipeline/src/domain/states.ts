export const PIPELINE_STATES = [
    "server_ready",
    "remuxed",
    "artifact_valid",
    "described",
    "provenance_review_required",
    "metadata_ready",
    "xvideos_admitted",
    "xvideos_uploading",
    "xvideos_uploaded",
    "xvideos_uncertain",
    "xvideos_verified",
    "cleanup_eligible",
    "blocked",
    "failed",
] as const;

export type PipelineState = typeof PIPELINE_STATES[number];

const ALLOWED_TRANSITIONS: Readonly<Record<PipelineState, readonly PipelineState[]>> = {
    server_ready: ["remuxed", "blocked", "failed", "cleanup_eligible"],
    remuxed: ["artifact_valid", "blocked", "failed", "cleanup_eligible"],
    artifact_valid: ["described", "blocked", "failed", "cleanup_eligible"],
    described: ["provenance_review_required", "metadata_ready", "blocked", "failed", "cleanup_eligible"],
    provenance_review_required: ["described", "blocked", "failed", "cleanup_eligible"],
    metadata_ready: ["xvideos_admitted", "blocked", "failed", "cleanup_eligible"],
    xvideos_admitted: ["xvideos_uploading", "metadata_ready", "blocked", "failed", "cleanup_eligible"],
    xvideos_uploading: ["xvideos_uploaded", "xvideos_uncertain", "metadata_ready", "blocked", "failed", "cleanup_eligible"],
    xvideos_uploaded: ["xvideos_verified", "xvideos_uncertain", "blocked", "failed", "cleanup_eligible"],
    xvideos_uncertain: ["xvideos_uploaded", "metadata_ready", "blocked", "failed", "cleanup_eligible"],
    xvideos_verified: ["cleanup_eligible", "failed"],
    cleanup_eligible: [],
    blocked: [],
    failed: ["server_ready", "remuxed", "artifact_valid", "described", "metadata_ready"],
};

export function assertTransition(from: PipelineState, to: PipelineState): void {
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
        throw new Error(`Invalid pipeline transition: ${from} -> ${to}`);
    }
}
