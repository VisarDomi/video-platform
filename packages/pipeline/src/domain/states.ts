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
    "short_waiting",
    "short_joined",
    "short_cancelled",
    "blocked",
    "failed",
] as const;

export type PipelineState = typeof PIPELINE_STATES[number];

const ALLOWED_TRANSITIONS: Readonly<Record<PipelineState, readonly PipelineState[]>> = {
    server_ready: ["remuxed", "artifact_valid", "blocked", "failed", "cleanup_eligible", "xvideos_uncertain", "short_waiting", "short_cancelled"],
    remuxed: ["artifact_valid", "blocked", "failed", "cleanup_eligible", "xvideos_uncertain", "short_cancelled"],
    artifact_valid: ["described", "blocked", "failed", "cleanup_eligible", "xvideos_uncertain", "short_cancelled"],
    described: ["provenance_review_required", "metadata_ready", "blocked", "failed", "cleanup_eligible", "xvideos_uncertain", "short_cancelled"],
    provenance_review_required: ["described", "blocked", "failed", "cleanup_eligible", "xvideos_uncertain"],
    metadata_ready: ["xvideos_admitted", "artifact_valid", "blocked", "failed", "cleanup_eligible", "xvideos_uncertain", "short_waiting", "short_cancelled"],
    xvideos_admitted: ["xvideos_uploading", "metadata_ready", "blocked", "failed", "cleanup_eligible"],
    xvideos_uploading: ["xvideos_uploaded", "xvideos_uncertain", "metadata_ready", "blocked", "failed", "cleanup_eligible"],
    xvideos_uploaded: ["artifact_valid", "xvideos_verified", "xvideos_uncertain", "blocked", "failed", "cleanup_eligible", "short_waiting"],
    xvideos_uncertain: ["xvideos_uploaded", "metadata_ready", "blocked", "failed", "cleanup_eligible"],
    xvideos_verified: ["cleanup_eligible", "failed"],
    cleanup_eligible: [],
    short_waiting: ["short_joined", "cleanup_eligible", "blocked", "server_ready", "short_cancelled"],
    short_joined: ["short_waiting", "cleanup_eligible", "blocked", "short_cancelled"],
    short_cancelled: ["server_ready", "short_waiting"],
    blocked: ["server_ready", "remuxed", "artifact_valid", "described", "metadata_ready", "short_waiting"],
    failed: ["server_ready", "remuxed", "artifact_valid", "described", "metadata_ready", "short_cancelled"],
};

export function assertTransition(from: PipelineState, to: PipelineState): void {
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
        throw new Error(`Invalid pipeline transition: ${from} -> ${to}`);
    }
}
