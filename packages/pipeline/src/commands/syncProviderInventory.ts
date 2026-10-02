import type { PipelineConfig } from "../config.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import type { ProviderInventoryEntry } from "../domain/types.js";
import type { ChromiumXvideosUploader } from "../upload/chromiumXvideosUploader.js";
import { createProviderUploader } from "../upload/providerFactory.js";

// The recording (source folder) identity in a title suffix:
// "[2026-01-20 140639 alias]" or the diagnostic "[2025-10-02 141119 alias | production-v2 | full]".
// Titles without one (old manual uploads) belong to no pipeline recording.
export function inventoryRecordingId(title: string): string | null {
    const suffix = title.match(/\[([^\[\]]+)\]\s*$/)?.[1];
    const id = suffix?.split(" | ")[0].trim() ?? "";
    return /^\d{4}-\d{2}-\d{2} \d{6} \S/.test(id) ? id : null;
}

// Settle every open XVideos confirmation from the stored account inventory.
// The listing is complete (its count matched the account total), so an ID or
// recording missing from it does not exist there. Copies that do exist are
// made due for the normal playback verification.
export function settleWithInventory(database: PipelineDatabase, now = new Date()): unknown[] {
    // A video being deleted is treated exactly like one already returning 404.
    const inventory = database.listProviderInventory("xvideos").filter((entry) => !entry.removalPending);
    const byRemote = new Set(inventory.map((entry) => entry.remoteId));
    const byRecording = Map.groupBy(inventory.filter((entry) => entry.recordingId), (entry) => entry.recordingId!);
    const results: unknown[] = [];
    const pending = database.dueUploadConfirmations(new Date("9999-12-31T23:59:59.999Z"))
        .filter((confirmation) => confirmation.uploadProvider === "xvideos");
    for (const confirmation of pending) {
        const { attemptId, recordingId } = confirmation;
        let remoteId = database.getUncertainUploadRemote(attemptId)?.remoteId ?? null;
        if (remoteId && !byRemote.has(remoteId)) {
            database.detachMissingRemote(attemptId, remoteId, now);
            results.push({ recordingId, disposition: "remote_id_missing", remoteId });
            remoteId = null;
        }
        if (remoteId) {
            database.makePendingConfirmationDue(recordingId, now);
            results.push({ recordingId, disposition: "present_verification_due", remoteId });
            continue;
        }
        const copies = byRecording.get(recordingId) ?? [];
        database.recordUploadEvidence(attemptId, { stage: "inventory_lookup", matches: copies.map((copy) => copy.remoteId) }, now);
        if (copies.length === 1) {
            database.attachUncertainRemote(attemptId, copies[0].remoteId);
            database.recordUploadLookup(attemptId, "found", now);
            database.makePendingConfirmationDue(recordingId, now);
            results.push({ recordingId, disposition: "found_verification_due", remoteId: copies[0].remoteId });
        } else if (copies.length > 1) {
            database.recordUploadLookup(attemptId, "ambiguous", now);
            results.push({ recordingId, disposition: "ambiguous_manual_review", remoteIds: copies.map((copy) => copy.remoteId) });
        } else {
            const requeued = database.recordUploadLookup(attemptId, "absent", now);
            results.push({ recordingId, disposition: requeued ? "absent_requeued" : "absent_waiting_retry_deadline" });
        }
    }
    return results;
}

export async function syncXvideosInventory(
    config: PipelineConfig,
    now = new Date(),
    uploaderFactory: (config: PipelineConfig) => Promise<Pick<ChromiumXvideosUploader, "withAuthenticatedPage" | "listAccountUploads">>
        = async (config) => await createProviderUploader(config, "xvideos") as ChromiumXvideosUploader,
): Promise<unknown> {
    if (!config.networkUploadsEnabled) {
        throw new Error("Inventory sync reads the provider account; explicit VIDEO_PIPELINE_NETWORK_UPLOADS=1 opt-in is required");
    }
    const uploader = await uploaderFactory(config);
    const listing = await uploader.withAuthenticatedPage((page) => uploader.listAccountUploads(page));
    const entries: ProviderInventoryEntry[] = listing.map((row) => ({ ...row, recordingId: inventoryRecordingId(row.title) }));
    const database = new PipelineDatabase(config.databasePath);
    try {
        database.replaceProviderInventory("xvideos", entries, now);
        const confirmations = settleWithInventory(database, now);
        const stored = database.listProviderInventory("xvideos");
        const live = stored.filter((entry) => !entry.removalPending);
        const removing = new Set(stored.filter((entry) => entry.removalPending).map((entry) => entry.remoteId));
        const present = new Set(live.map((entry) => entry.remoteId));
        const known = database.knownRemoteIds();
        const perRecording = Map.groupBy(live.filter((entry) => entry.recordingId), (entry) => entry.recordingId!);
        return {
            provider: "xvideos",
            syncedAt: now.toISOString(),
            total: entries.length,
            statuses: Object.fromEntries([...Map.groupBy(entries, (entry) => entry.status)].map(([status, rows]) => [status, rows.length])),
            confirmations,
            // Reported, never acted on: deciding about these is the operator's call.
            verifiedButMissing: database.listVerifiedRemoteUploads("xvideos").filter((upload) => !present.has(upload.remoteId))
                .map((upload) => ({ ...upload, reason: removing.has(upload.remoteId) ? "removal_pending" : "absent" })),
            removalPending: stored.filter((entry) => entry.removalPending)
                .map(({ remoteId, title, status, recordingId }) => ({ remoteId, title, status, recordingId })),
            notInLedger: live.filter((entry) => !known.has(entry.remoteId))
                .map(({ remoteId, title, status, recordingId }) => ({ remoteId, title, status, recordingId })),
            duplicateCopies: [...perRecording].filter(([, rows]) => rows.length > 1)
                .map(([recordingId, rows]) => ({ recordingId, remoteIds: rows.map((row) => row.remoteId) })),
        };
    } finally {
        database.close();
    }
}
