import { descriptionPromptVersion } from "descriptor";
import type { ActiveUploadProvider } from "../config/uploadProviders.js";
import type { PipelineDatabase } from "../db/pipelineDatabase.js";
import { containedPhrases } from "../upload/providerWarnings.js";

export type RejectedPhraseVerdict =
    | { kind: "clean" }
    // The description predates the current phrase list: describe it again.
    | { kind: "stale_description"; phrases: string[] }
    // Already described with these phrases in the prompt and still contains them.
    | { kind: "manual_review"; phrases: string[] };

// Local sanity check of composed metadata against the phrases a provider has
// rejected before. Substring matching mirrors the provider, so "ambient" fails
// on "ambien". No network: this replaces finding out after the file upload.
export async function checkRejectedPhrases(
    database: PipelineDatabase,
    recordingId: string,
    provider: ActiveUploadProvider,
): Promise<RejectedPhraseVerdict> {
    const metadata = database.getUploadMetadata(recordingId);
    if (!metadata) return { kind: "clean" };
    const phrases = containedPhrases([metadata.title, metadata.description, ...metadata.tags],
        database.listRejectedPhrases(provider));
    if (!phrases.length) return { kind: "clean" };
    const description = database.getDescription(recordingId);
    const current = await descriptionPromptVersion(database.listRejectedPhrases());
    return description && description.promptVersion !== current
        ? { kind: "stale_description", phrases }
        : { kind: "manual_review", phrases };
}

export function rejectedPhraseReason(provider: ActiveUploadProvider, phrases: readonly string[]): string {
    return `${provider} rejects ${phrases.map((phrase) => `'${phrase}'`).join(", ")} in upload metadata`;
}

// Apply a verdict to a metadata_ready recording before any bytes are sent.
export async function settleRejectedPhrases(
    database: PipelineDatabase,
    recordingId: string,
    provider: ActiveUploadProvider,
    now = new Date(),
): Promise<RejectedPhraseVerdict> {
    const verdict = await checkRejectedPhrases(database, recordingId, provider);
    if (verdict.kind === "stale_description") {
        database.returnForRedescription(recordingId,
            `${rejectedPhraseReason(provider, verdict.phrases)}; describing again with the phrases avoided`, now);
    } else if (verdict.kind === "manual_review") {
        database.transition(recordingId, "metadata_ready", "blocked",
            `${rejectedPhraseReason(provider, verdict.phrases)}; still present after re-description, manual review required`, now);
    }
    return verdict;
}
