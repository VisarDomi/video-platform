export const PIPELINE_STATES = [
    "server_ready",
    "remuxed",
    "artifact_valid",
    "described",
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
    server_ready: ["remuxed", "blocked", "failed"],
    remuxed: ["artifact_valid", "blocked", "failed"],
    artifact_valid: ["described", "blocked", "failed"],
    described: ["xvideos_admitted", "blocked", "failed"],
    xvideos_admitted: ["xvideos_uploading", "described", "blocked", "failed"],
    xvideos_uploading: ["xvideos_uploaded", "xvideos_uncertain", "described", "failed"],
    xvideos_uploaded: ["xvideos_verified", "xvideos_uncertain", "failed"],
    xvideos_uncertain: ["xvideos_uploaded", "failed"],
    xvideos_verified: ["cleanup_eligible", "failed"],
    cleanup_eligible: [],
    blocked: [],
    failed: ["server_ready", "remuxed", "artifact_valid", "described"],
};

export function assertTransition(from: PipelineState, to: PipelineState): void {
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
        throw new Error(`Invalid pipeline transition: ${from} -> ${to}`);
    }
}
