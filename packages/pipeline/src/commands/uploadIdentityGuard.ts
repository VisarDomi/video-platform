import { access } from "node:fs/promises";
import type { PipelineConfig } from "../config.js";
import type { PipelineDatabase } from "../db/pipelineDatabase.js";
import type { Recording } from "../domain/types.js";
import { cleanupAcceptedConversions } from "./acceptedConversions.js";

// SQLite is the single source of truth for whether a recording is already on
// the upload provider. The guard runs at every job entry point: a recording with an edit
// ID is never remuxed, described, or uploaded again.

export type UploadIdentityGuardOutcome =
    | { kind: "proceed" }
    | { kind: "verified_cleaned"; remoteId: string; remoteUrl: string | null }
    | { kind: "verified_retained"; remoteId: string; remoteUrl: string | null }
    | { kind: "unverified_refused"; remoteId: string; verificationScheduled: boolean };

export async function guardUploadIdentity(
    database: PipelineDatabase,
    recording: Recording,
    config: Pick<PipelineConfig, "cleanupEnabled"> & Partial<Pick<PipelineConfig, "stagingRoot">>,
): Promise<UploadIdentityGuardOutcome> {
    const identity = database.getUploadIdentity(recording.id);
    if (!identity) return { kind: "proceed" };
    if (identity.verified) {
        if (!config.cleanupEnabled || database.getComparisonTrial()) {
            return { kind: "verified_retained", remoteId: identity.remoteId, remoteUrl: identity.remoteUrl };
        }
        // Verified online: nothing left to do but clean the staging artifact.
        if (config.cleanupEnabled && !database.getComparisonTrial()) {
            if(config.stagingRoot) await cleanupAcceptedConversions(database,{...config,stagingRoot:config.stagingRoot});
        }
        if (!database.getComparisonTrial() && database.listQueuedProductionArtifacts(recording.id).length === 0) {
            database.transitionToCleanupEligible(
                recording.id,
                `already verified online (${identity.remoteId}); no further processing`,
                new Date(),
            );
        }
        const artifact=database.getArtifact(recording.id);
        const retained=artifact ? await access(artifact.path).then(()=>true,(error:NodeJS.ErrnoException)=>error.code!=='ENOENT') : false;
        return { kind: retained ? "verified_retained" : "verified_cleaned", remoteId: identity.remoteId, remoteUrl: identity.remoteUrl };
    }
    // Refuse duplicate work without shortening the seven-day confirmation window.
    const scheduled = database.hasPendingConfirmation(recording.id);
    return {
        kind: "unverified_refused",
        remoteId: identity.remoteId,
        verificationScheduled: scheduled,
    };
}

export function refusalMessage(outcome: Extract<UploadIdentityGuardOutcome, { kind: "unverified_refused" }>): string {
    return `Recording already has an upload (${outcome.remoteId}); refusing to start the job`
        + (outcome.verificationScheduled
            ? "; verification keeps its stored deadline"
            : " and no pending confirmation exists — manual review required");
}
