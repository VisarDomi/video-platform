import type { PipelineConfig } from "../config.js";
import type { PipelineDatabase } from "../db/pipelineDatabase.js";
import { createProviderUploader } from "./providerFactory.js";

// Managed identities are guarded by SQLite before this is invoked. This
// second, read-only check covers manual/older XVideos uploads outside that ledger.
export async function checkXvideosBeforePorntrex(
    database: PipelineDatabase,
    recordingId: string,
    identity: string,
    config: PipelineConfig,
    factory = createProviderUploader,
): Promise<{ recordingId: string; state: string; disposition: string; remoteId: string } | null> {
    if (!identity.trim()) throw new Error("Cross-provider duplicate check lacks a filename identity");
    const browser = await factory(config, "xvideos");
    const existing = await browser.findUploadedCopy(identity);
    if (existing.kind === "found") {
        database.parkUploadedCopy(recordingId, existing.remoteId, existing.remoteUrl, new Date(), "xvideos");
        return { recordingId, state: "xvideos_uncertain", disposition: "skipped_existing_xvideos", remoteId: existing.remoteId };
    }
    if (existing.kind !== "not_found") throw new Error("Ambiguous XVideos identity; refusing Porntrex upload");
    // Authentication, HTTP and incomplete-list errors deliberately propagate;
    // unknown acceptance must not become a duplicate on the other destination.
    return null;
}
