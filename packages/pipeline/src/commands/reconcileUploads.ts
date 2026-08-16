import type { PipelineConfig } from "../config.js";
import { readXvideosCredentials } from "../config/secrets.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
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
        for (const confirmation of database.dueUploadConfirmations(now)) {
            let remote = database.getUncertainUploadRemote(confirmation.attemptId);
            if (!remote) {
                // Older attempts without a captured ID: resolve the URL via
                // the authenticated uploads list first.
                const entry = await browser.findEntryByMatchKey(confirmation.matchKey);
                if (entry) remote = { remoteId: entry.remoteId, remoteUrl: entry.remoteUrl };
            }
            if (!remote) {
                results.push({
                    recordingId: confirmation.recordingId,
                    disposition: "not_ready",
                    reason: "no remote video URL resolved yet",
                });
                continue;
            }
            const probe = await browser.probeVideoLink(remote.remoteUrl);
            if (probe === "published") {
                database.reconcileUncertain(confirmation.attemptId, remote.remoteId, remote.remoteUrl, now);
                database.markRemoteVerified(
                    confirmation.recordingId,
                    remote.remoteId,
                    remote.remoteUrl,
                    null,
                    now,
                );
                results.push({ recordingId: confirmation.recordingId, disposition: "verified", remote });
            } else if (probe === "deleted") {
                database.markConfirmationAbsent(confirmation.attemptId, now);
                results.push({ recordingId: confirmation.recordingId, disposition: "absent_retryable" });
            } else {
                results.push({
                    recordingId: confirmation.recordingId,
                    disposition: "not_ready",
                    reason: "video link does not open yet",
                });
            }
        }
        return { checkedAt: now.toISOString(), results };
    } finally {
        database.close();
    }
}
