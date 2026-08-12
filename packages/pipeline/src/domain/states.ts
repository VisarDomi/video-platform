export const PIPELINE_STATES = [
    "discovered",
    "playlist_repaired",
    "integrity_ready",
    "remuxed",
    "artifact_valid",
    "described",
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
    discovered: ["playlist_repaired", "blocked", "failed"],
    playlist_repaired: ["integrity_ready", "blocked", "failed"],
    integrity_ready: ["remuxed", "blocked", "failed"],
    remuxed: ["artifact_valid", "blocked", "failed"],
    artifact_valid: ["described", "blocked", "failed"],
    described: ["oldhost_admitted", "blocked", "failed"],
    oldhost_admitted: ["oldhost_uploading", "described", "blocked", "failed"],
    oldhost_uploading: ["oldhost_uploaded", "oldhost_uncertain", "described", "failed"],
    oldhost_uploaded: ["oldhost_verified", "oldhost_uncertain", "failed"],
    oldhost_uncertain: ["oldhost_uploaded", "failed"],
    oldhost_verified: ["cleanup_eligible", "failed"],
    cleanup_eligible: [],
    blocked: [],
    failed: ["discovered", "playlist_repaired", "integrity_ready", "remuxed", "artifact_valid", "described"],
};

export function assertTransition(from: PipelineState, to: PipelineState): void {
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
        throw new Error(`Invalid pipeline transition: ${from} -> ${to}`);
    }
}
