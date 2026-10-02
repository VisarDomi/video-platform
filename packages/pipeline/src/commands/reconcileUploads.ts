import type { PipelineConfig } from "../config.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import { cleanupArtifact } from "../stages/cleanupArtifact.js";
import type { ChromiumXvideosUploader } from "../upload/chromiumXvideosUploader.js";
import { createProviderUploader } from "../upload/providerFactory.js";
import { writeComparisonReport } from "./comparisonTrial.js";
import { CURRENT_PRODUCTION_VERSION } from "../domain/productionVersion.js";
import { uploadLookupIdentity } from "../metadata/composeUploadMetadata.js";

export async function reconcileDueUploads(config: PipelineConfig, now = new Date(),
    browserOverride?: Pick<ChromiumXvideosUploader, "withAuthenticatedPage" | "probeUploadStatus">
        & Partial<Pick<ChromiumXvideosUploader, "recoverUploadId" | "lookupUpload">>,
    providerFactory = createProviderUploader,
): Promise<unknown> {
    if (!config.networkUploadsEnabled) {
        throw new Error("Network reconciliation is disabled; explicit VIDEO_PIPELINE_NETWORK_UPLOADS=1 opt-in is required");
    }
    const database = new PipelineDatabase(config.databasePath);
    const results: unknown[] = [];
    try {
        if (config.comparisonTrialOnly && database.getProductionVersion() !== CURRENT_PRODUCTION_VERSION) {
            throw new Error("Retired-version verification must not run in the v4 comparison worker");
        }
        results.push(...database.recoverInterruptedUploads(now));
        database.recoverAcceptedVerifications(now);
        results.push(...database.settleUnsubmittedAttempts("porntrex", now)
            .map((recordingId) => ({ recordingId, disposition: "unsubmitted_attempt_released" })));
        // One login flow, then every due confirmation is checked on that same
        // authenticated page.
        const due = database.dueUploadConfirmations(now);
        if (due.length === 0) return { checkedAt: now.toISOString(), results };
        // Destination is pinned to the attempt, not today's active provider.
        // Old XVideos confirmations remain XVideos checks after selecting Porntrex.
        for (const provider of new Set(due.map(confirmation => confirmation.uploadProvider))) {
        const providerDue = due.filter(confirmation => confirmation.uploadProvider === provider);
        try {
        const browser: NonNullable<typeof browserOverride> = browserOverride ?? await providerFactory(config, provider);
        await browser.withAuthenticatedPage(async (page) => {
            for (const confirmation of providerDue) {
                try {
                let remoteId = database.getUncertainUploadRemote(confirmation.attemptId)?.remoteId ?? null;
                let probe = remoteId ? await browser.probeUploadStatus(page, remoteId) : null;
                if (remoteId && probe?.outcome === "missing") {
                    // 404 means the ID does not exist. Forget it and settle the
                    // attempt by filename, exactly as if no ID was ever captured.
                    database.detachMissingRemote(confirmation.attemptId, remoteId, now);
                    remoteId = null;
                    probe = null;
                }
                if (!remoteId) {
                    const recording = database.get(confirmation.recordingId);
                    const metadata = database.getUploadMetadata(confirmation.recordingId);
                    const identity = recording && metadata ? uploadLookupIdentity(recording,
                        database.getArtifactPart(recording.id) ?? "full", metadata.title) : null;
                    if (identity && browser.lookupUpload) {
                        const lookup = await browser.lookupUpload(page, identity);
                        if (lookup.kind === "found") {
                            remoteId = lookup.remoteId;
                            database.attachUncertainRemote(confirmation.attemptId, remoteId);
                        }
                        const requeued = database.recordUploadLookup(confirmation.attemptId, lookup.kind, now);
                        database.recordUploadEvidence(confirmation.attemptId, { stage: "filename_lookup", identity, ...lookup }, now);
                        if (requeued) {
                            results.push({ recordingId: confirmation.recordingId, disposition: "weekly_retry_eligible" });
                            continue;
                        }
                    } else if (identity && browser.recoverUploadId) {
                        // Legacy adapters can prove a positive ID, never absence.
                        remoteId = await browser.recoverUploadId(page, identity);
                        if (remoteId) database.attachUncertainRemote(confirmation.attemptId, remoteId);
                    }
                }
                if (!remoteId) {
                    database.postponeConfirmation(confirmation.attemptId,
                        "No unique filename match; daily lookup, no upload before a clean negative lookup and weekly deadline", now);
                    results.push({
                        recordingId: confirmation.recordingId,
                        disposition: "identity_recheck_scheduled",
                        reason: "no stored edit ID; acceptance still unknown",
                    });
                    continue;
                }
                probe ??= await browser.probeUploadStatus(page, remoteId);
                if (probe.outcome === "missing") {
                    database.detachMissingRemote(confirmation.attemptId, remoteId, now);
                    database.postponeConfirmation(confirmation.attemptId, probe.reason ?? "Recovered ID returned 404", now);
                    results.push({ recordingId: confirmation.recordingId, disposition: "identity_recheck_scheduled", reason: probe.reason });
                    continue;
                }
                database.recordUploadEvidence(confirmation.attemptId, { stage: "playback_verification", remoteId, ...probe }, now);
                if (probe.outcome === "online" && probe.remoteUrl) {
                    const verifiedArtifact = database.getArtifact(confirmation.recordingId);
                    const afterVerification = database.verifyUpload(
                        confirmation.attemptId,
                        remoteId,
                        probe.remoteUrl,
                        now,
                    );
                    // Verified online: clean up only the pipeline staging
                    // artifact. Original recording folders are left untouched.
                    if (config.cleanupEnabled && !database.getComparisonTrial()) {
                        if (verifiedArtifact) {
                            await cleanupArtifact(verifiedArtifact.path);
                            if (afterVerification.state === "xvideos_verified") database.transition(
                                confirmation.recordingId,
                                "xvideos_verified",
                                "cleanup_eligible",
                                "verified online; pipeline artifact cleaned",
                                now,
                            );
                        }
                    }
                    results.push({
                        recordingId: confirmation.recordingId,
                        disposition: "online",
                        remoteId,
                        remoteUrl: probe.remoteUrl,
                    });
                } else {
                    database.postponeConfirmation(confirmation.attemptId,
                        probe.reason ?? "Full-HD playback not yet confirmed", now);
                    results.push({
                        recordingId: confirmation.recordingId,
                        disposition: "not_ready",
                        reason: probe.reason ?? "Full-HD playback not yet confirmed",
                    });
                }
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    database.postponeConfirmation(confirmation.attemptId, reason, now);
                    results.push({ recordingId: confirmation.recordingId, disposition: "verification_retry_scheduled", reason });
                }
            }
        }); } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            // Authentication failure must not cause a new browser/login attempt
            // every 30 seconds, nor erase the uncertain acceptance state.
            for (const confirmation of providerDue) database.postponeConfirmation(confirmation.attemptId, reason, now);
            results.push({ disposition: "verification_login_retry_scheduled", uploadProvider: provider, reason });
        }
        }
        // Contradictory recordings (upload states without any remote identity
        // and without a pending confirmation) go to manual review.
        for (const contradiction of database.listUploadContradictions()) {
            database.transition(
                contradiction.id,
                contradiction.state,
                "blocked",
                "upload state without remote identity or pending confirmation; manual review required",
                now,
            );
            results.push({ recordingId: contradiction.id, disposition: "manual_review" });
        }
        return { checkedAt: now.toISOString(), results };
    } finally {
        database.close();
        if (config.comparisonTrialOnly) await writeComparisonReport(config);
    }
}
