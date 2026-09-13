import type { PipelineConfig } from "../config.js";
import { readXvideosCredentials } from "../config/secrets.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import { cleanupArtifact } from "../stages/cleanupArtifact.js";
import { ChromiumXvideosUploader } from "../upload/chromiumXvideosUploader.js";
import { writeComparisonReport } from "./comparisonTrial.js";
import { CURRENT_PRODUCTION_VERSION } from "../domain/productionVersion.js";
import { productionUploadIdentity, hasDiagnosticUploadIdentity } from "../metadata/composeUploadMetadata.js";

export async function reconcileDueUploads(config: PipelineConfig, now = new Date(),
    browserOverride?: Pick<ChromiumXvideosUploader, "withAuthenticatedPage" | "probeUploadStatus">
        & Partial<Pick<ChromiumXvideosUploader, "recoverUploadId">>,
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
        // One login flow, then every due confirmation is checked on that same
        // authenticated page.
        const due = database.dueUploadConfirmations(now);
        if (due.length === 0) return { checkedAt: now.toISOString(), results };
        try {
        const browser = browserOverride ?? new ChromiumXvideosUploader({
            executablePath: config.chromiumExecutablePath,
            profilePath: config.browserProfilePath,
            ...await readXvideosCredentials(config.credentialsFilePath),
        });
        await browser.withAuthenticatedPage(async (page) => {
            for (const confirmation of database.dueUploadConfirmations(now)) {
                try {
                let remoteId = database.getUncertainUploadRemote(confirmation.attemptId)?.remoteId ?? null;
                if (!remoteId) {
                    const recording = database.get(confirmation.recordingId);
                    const metadata = database.getUploadMetadata(confirmation.recordingId);
                    const identity = recording ? productionUploadIdentity(recording,
                        database.getArtifactPart(recording.id) ?? "full") : null;
                    if (identity && metadata && hasDiagnosticUploadIdentity(metadata.title, identity) && browser.recoverUploadId) {
                        remoteId = await browser.recoverUploadId(page, identity);
                        if (remoteId) database.attachUncertainRemote(confirmation.attemptId, remoteId);
                    }
                }
                if (!remoteId) {
                    database.postponeConfirmation(confirmation.attemptId,
                        "No uniquely identified current-generation upload found; daily recheck, no automatic re-upload", now);
                    results.push({
                        recordingId: confirmation.recordingId,
                        disposition: "identity_recheck_scheduled",
                        reason: "no stored edit ID; acceptance still unknown",
                    });
                    continue;
                }
                const probe = await browser.probeUploadStatus(page, remoteId);
                database.recordUploadEvidence(confirmation.attemptId, { stage: "playback_verification", remoteId, ...probe }, now);
                if (probe.outcome === "online" && probe.remoteUrl) {
                    const verifiedArtifact = database.getArtifact(confirmation.recordingId);
                    database.reconcileUncertain(confirmation.attemptId, remoteId, probe.remoteUrl, now);
                    const afterVerification = database.markRemoteVerified(
                        confirmation.recordingId,
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
            for (const confirmation of due) database.postponeConfirmation(confirmation.attemptId, reason, now);
            results.push({ disposition: "verification_login_retry_scheduled", reason });
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
