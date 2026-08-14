import type { PipelineConfig } from "../config.js";
import { readOldHostCredentials } from "../config/secrets.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import { ChromiumOldHostUploader } from "../upload/chromiumOldHostUploader.js";

export async function reconcileDueUploads(config: PipelineConfig, now = new Date()): Promise<unknown> {
    if (!config.networkUploadsEnabled) {
        throw new Error("Network reconciliation is disabled; explicit VIDEO_PIPELINE_NETWORK_UPLOADS=1 opt-in is required");
    }
    const credentials = await readOldHostCredentials(config.credentialsFilePath);
    const browser = new ChromiumOldHostUploader({
        executablePath: config.chromiumExecutablePath,
        profilePath: config.browserProfilePath,
        ...credentials,
    });
    const database = new PipelineDatabase(config.databasePath);
    const results: unknown[] = [];
    try {
        results.push(...database.recoverInterruptedUploads(now));
        for (const confirmation of database.dueUploadConfirmations(now)) {
            const entry = await browser.findEntryByMatchKey(confirmation.matchKey);
            if (entry) {
                database.reconcileUncertain(confirmation.attemptId, entry.remoteId, entry.remoteUrl, now);
                database.markRemoteVerified(
                    confirmation.recordingId,
                    entry.remoteId,
                    entry.remoteUrl,
                    entry.moderationStatus,
                    now,
                );
                results.push({ recordingId: confirmation.recordingId, disposition: "found", entry });
            } else {
                database.markConfirmationAbsent(confirmation.attemptId, now);
                results.push({ recordingId: confirmation.recordingId, disposition: "absent_retryable" });
            }
        }
        return { checkedAt: now.toISOString(), results };
    } finally {
        database.close();
    }
}
