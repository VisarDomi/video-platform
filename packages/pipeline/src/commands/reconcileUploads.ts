import type { PipelineConfig } from "../config.js";
import { readXvideosCredentials } from "../config/secrets.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import { cleanupArtifact } from "../stages/cleanupArtifact.js";
import { ChromiumXvideosUploader } from "../upload/chromiumXvideosUploader.js";

export async function reconcileDueUploads(config: PipelineConfig, now = new Date()): Promise<unknown> {
    if (!config.networkUploadsEnabled) {
        throw new Error("Network reconciliation is disabled; explicit VIDEO_PIPELINE_NETWORK_UPLOADS=1 opt-in is required");
    }
    const credentials = await readXvideosCredentials(config.credentialsFilePath);
    const browser = new ChromiumXvideosUploader({
        executablePath: config.chromiumExecutablePath,
        profilePath: config.browserProfilePath,
        ...credentials,
    });
    const database = new PipelineDatabase(config.databasePath);
    const results: unknown[] = [];
    try {
        results.push(...database.recoverInterruptedUploads(now));
        // One login flow, then every due confirmation is checked on that same
        // authenticated page.
        await browser.withAuthenticatedPage(async (page) => {
            for (const confirmation of database.dueUploadConfirmations(now)) {
                const remoteId = database.getUncertainUploadRemote(confirmation.attemptId)?.remoteId ?? null;
                if (!remoteId) {
                    // Should never happen: uploaded without a captured edit ID.
                    // Manual review, never a blind re-upload.
                    database.settleConfirmationManualReview(confirmation.attemptId, now);
                    database.transition(
                        confirmation.recordingId,
                        "xvideos_uncertain",
                        "blocked",
                        "upload without a stored edit ID; manual review required",
                        now,
                    );
                    results.push({
                        recordingId: confirmation.recordingId,
                        disposition: "manual_review",
                        reason: "no stored edit ID",
                    });
                    continue;
                }
                const probe = await browser.probeUploadStatus(page, remoteId);
                if (probe.outcome === "online" && probe.remoteUrl) {
                    database.reconcileUncertain(confirmation.attemptId, remoteId, probe.remoteUrl, now);
                    database.markRemoteVerified(
                        confirmation.recordingId,
                        remoteId,
                        probe.remoteUrl,
                        now,
                    );
                    // Verified online: clean up only the pipeline staging
                    // artifact. Original recording folders are left untouched.
                    if (config.cleanupEnabled) {
                        const artifact = database.getArtifact(confirmation.recordingId);
                        if (artifact) {
                            await cleanupArtifact(artifact.path);
                            database.transition(
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
                    results.push({
                        recordingId: confirmation.recordingId,
                        disposition: "not_ready",
                        reason: "edit page has no direct video link yet",
                    });
                }
            }
        });
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
    }
}
