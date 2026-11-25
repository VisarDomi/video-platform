import type { PipelineConfig } from "../config.js";
import type { PipelineDatabase } from "../db/pipelineDatabase.js";
import { cleanupAcceptedConversions } from "./acceptedConversions.js";

// The owner's decision for a published upload whose best version stays below Full-HD (a copy
// converted under an older policy): it counts as backed up. The destination keeps it (it
// cannot be deleted there), so it is verified as it is: its daily check ends, its conversion
// is cleaned up and its recording is backed up like any other. The upload's evidence keeps
// "accepted_below_full_hd" with the best version found, the marker for every later count.
type Rendition = { width: number; height: number; label?: string };
type Playback = { stage: "playback_verification"; outcome?: string; remoteUrl?: string; renditions?: Rendition[]; checkedAt?: string };

export interface BelowFullHdResult {
    readonly remoteId: string;
    readonly recordingId?: string;
    readonly disposition: "accepted_below_full_hd" | "already_accepted" | "would_accept" | "refused";
    readonly best?: Rendition;
    readonly reason?: string;
}

export async function acceptBelowFullHd(database: PipelineDatabase, config: PipelineConfig, provider: string,
    remoteIds: readonly string[], apply: boolean, now = new Date()): Promise<{ results: BelowFullHdResult[]; cleanup?: unknown; note?: string }> {
    const results: BelowFullHdResult[] = [];
    // As the worker does after a verification: with cleanup on, a fully verified recording
    // becomes cleanup-eligible.
    const backedUp = (recordingId: string, remoteId: string) => {
        if (config.cleanupEnabled && database.get(recordingId)?.state === "upload_verified" && !database.getComparisonTrial()) {
            database.transition(recordingId, "upload_verified", "cleanup_eligible",
                `all required parts verified online (${remoteId} accepted below Full-HD)`, now);
        }
    };
    for (const remoteId of remoteIds) {
        const upload = database.pendingUploadByRemoteId(provider, remoteId);
        if (!upload) {
            // Accepted before: finish what that run could not (a hold, the backed-up state).
            const accepted = database.acceptedBelowFullHdUpload(provider, remoteId);
            if (!accepted) { results.push({ remoteId, disposition: "refused", reason: "no pending check of an upload with this ID" }); continue; }
            if (apply) {
                database.releaseRetentionHold(accepted.attemptId);
                backedUp(accepted.recordingId, remoteId);
            }
            results.push({ remoteId, recordingId: accepted.recordingId, disposition: apply ? "already_accepted" : "would_accept" });
            continue;
        }
        // Only a copy the last check found published, playable, and below Full-HD.
        const last = upload.evidence.filter((entry): entry is Playback => (entry as Playback)?.stage === "playback_verification").at(-1);
        const best = [...(last?.renditions ?? [])].sort((a, b) => b.width * b.height - a.width * a.height)[0];
        const url = last?.remoteUrl ?? "";
        if (!last || last.outcome !== "not_ready" || !best || !url.includes(`/video/${remoteId}/`)) {
            results.push({ remoteId, recordingId: upload.recordingId, disposition: "refused", reason: "the last check found no published, playable copy" });
            continue;
        }
        if (Math.min(best.width, best.height) >= 1080) {
            results.push({ remoteId, recordingId: upload.recordingId, disposition: "refused", best, reason: "a Full-HD version exists; the daily check verifies it" });
            continue;
        }
        if (!apply) { results.push({ remoteId, recordingId: upload.recordingId, disposition: "would_accept", best }); continue; }
        database.recordUploadEvidence(upload.attemptId, { stage: "accepted_below_full_hd", remoteId, remoteUrl: url, best,
            checkedAt: last.checkedAt ?? null, reason: "owner decision: a published copy below Full-HD counts as backed up" }, now);
        database.releaseRetentionHold(upload.attemptId);
        database.verifyUpload(upload.attemptId, remoteId, url, now);
        backedUp(upload.recordingId, remoteId);
        results.push({ remoteId, recordingId: upload.recordingId, disposition: "accepted_below_full_hd", best });
    }
    const cleanup = apply && results.some(result => result.disposition === "accepted_below_full_hd" || result.disposition === "already_accepted")
        ? await cleanupAcceptedConversions(database, config, now) : undefined;
    return { results, ...(cleanup ? { cleanup } : {}),
        ...(apply && !config.cleanupEnabled ? { note: "cleanup is off here: run with the worker's VIDEO_PIPELINE_CLEANUP=1" } : {}) };
}
