import type { PipelineConfig } from "../config.js";
import type { PipelineDatabase } from "../db/pipelineDatabase.js";
import type { Recording } from "../domain/types.js";
import { cleanupArtifact } from "../stages/cleanupArtifact.js";

// SQLite is the single source of truth for whether a recording is already on
// XVideos. The guard runs at every job entry point: a recording with an edit
// ID is never remuxed, described, or uploaded again.

export type UploadIdentityGuardOutcome =
    | { kind: "proceed" }
    | { kind: "verified_cleaned"; remoteId: string; remoteUrl: string | null }
    | { kind: "unverified_refused"; remoteId: string; verificationScheduled: boolean };

export async function guardUploadIdentity(
    database: PipelineDatabase,
    recording: Recording,
    config: Pick<PipelineConfig, "cleanupEnabled">,
): Promise<UploadIdentityGuardOutcome> {
    const identity = database.getUploadIdentity(recording.id);
    if (!identity) return { kind: "proceed" };
    if (identity.verified) {
        // Verified online: nothing left to do but clean the staging artifact.
        if (config.cleanupEnabled) {
            const artifact = database.getArtifact(recording.id);
            if (artifact) await cleanupArtifact(artifact.path);
        }
        database.transitionToCleanupEligible(
            recording.id,
            `already verified online (${identity.remoteId}); no further processing`,
            new Date(),
        );
        return { kind: "verified_cleaned", remoteId: identity.remoteId, remoteUrl: identity.remoteUrl };
    }
    // Unverified: refuse every local job. If a pending confirmation exists,
    // accelerate it so the next reconcile verifies the upload.
    const scheduled = database.makePendingConfirmationDue(recording.id, new Date()) > 0;
    return {
        kind: "unverified_refused",
        remoteId: identity.remoteId,
        verificationScheduled: scheduled,
    };
}

export function refusalMessage(outcome: Extract<UploadIdentityGuardOutcome, { kind: "unverified_refused" }>): string {
    return `Recording already has an XVideos upload (${outcome.remoteId}); refusing to start the job`
        + (outcome.verificationScheduled
            ? "; verification is scheduled for the next reconcile"
            : " and no pending confirmation exists — manual review required");
}
