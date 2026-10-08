import type { PipelineConfig } from "../config.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import { cleanupArtifact } from "../stages/cleanupArtifact.js";
import type { ChromiumXvideosUploader } from "../upload/chromiumXvideosUploader.js";
import { createProviderUploader } from "../upload/providerFactory.js";
import { writeComparisonReport } from "./comparisonTrial.js";
import { CURRENT_PRODUCTION_VERSION } from "../domain/productionVersion.js";
import { uploadLookupIdentity } from "../metadata/composeUploadMetadata.js";
import { swappedWords, type StoredPorntrexMetadata } from "../upload/porntrexMetadata.js";

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
                const removed = (id: string, reason: string | undefined) => {
                    // The provider gave this video an ID, so it existed; now it is
                    // gone (404 and unlisted). Never back to that provider.
                    database.markProviderRemoved(confirmation.attemptId, id,
                        `${confirmation.uploadProvider} removed video ${id} after upload (${reason ?? "404"}); blocked for manual review: it goes only to another upload provider, so once one is active \`npm run retry -w pipeline -- "${confirmation.recordingId}"\` queues it there`, now);
                    results.push({ recordingId: confirmation.recordingId, disposition: "provider_removed", remoteId: id });
                };
                if (remoteId && probe?.outcome === "missing") {
                    removed(remoteId, probe.reason);
                    continue;
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
                    removed(remoteId, probe.reason);
                    continue;
                }
                const { stored, ...probeEvidence } = probe as typeof probe & { stored?: StoredPorntrexMetadata | null };
                database.recordUploadEvidence(confirmation.attemptId, { stage: "playback_verification", remoteId, ...probeEvidence }, now);
                const sent = stored ? database.getUploadMetadata(confirmation.recordingId) : null;
                if (stored && sent) {
                    // Porntrex silently swaps filtered words: learn them so new
                    // descriptions avoid them (the prompt appends every learned phrase).
                    const learned = [...new Set([...swappedWords(sent.title, stored.title), ...swappedWords(sent.description, stored.description)])];
                    if (learned.length) {
                        database.recordRejectedPhrases(confirmation.uploadProvider, learned, confirmation.attemptId, now);
                        database.recordUploadEvidence(confirmation.attemptId, { stage: "provider_swapped_words", learned }, now);
                        results.push({ recordingId: confirmation.recordingId, disposition: "learned_swapped_words", learned });
                    }
                }
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
                    // Porntrex publishes up to about a day after upload: while it is
                    // still processing, look again in two hours instead of a day.
                    const processing = (probe as { processing?: boolean }).processing === true;
                    database.postponeConfirmation(confirmation.attemptId,
                        probe.reason ?? "Full-HD playback not yet confirmed", now, processing ? 2 * 60 * 60_000 : 24 * 60 * 60_000);
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
