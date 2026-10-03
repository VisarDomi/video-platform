import { descriptionPromptVersion, rewriteAvoidingPhrases } from "descriptor";
import type { ActiveUploadProvider } from "../config/uploadProviders.js";
import type { PipelineDatabase } from "../db/pipelineDatabase.js";
import { containedPhrases } from "../upload/providerWarnings.js";
import { composeUploadMetadata } from "./composeUploadMetadata.js";

export type RejectedPhraseVerdict =
    | { kind: "clean" }
    // The local model rewrote the text without the phrases; upload proceeds.
    | { kind: "rewritten"; phrases: string[] }
    // The description predates the current phrase list: describe it again.
    | { kind: "stale_description"; phrases: string[] }
    // Already described with these phrases in the prompt and still contains them.
    | { kind: "manual_review"; phrases: string[] };

export type DescriptionRewriter = (text: { title: string; description: string }, phrases: readonly string[]) =>
    Promise<{ title: string; description: string }>;

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

// Cheap fix first: the local model rewrites only the model-written title and
// description (text, seconds), checked again here before it is kept.
async function rewriteText(database: PipelineDatabase, recordingId: string, rewrite: DescriptionRewriter, now: Date): Promise<boolean> {
    const description = database.getDescription(recordingId);
    const recording = database.get(recordingId);
    const provenance = database.getProvenance(recordingId);
    const output = description?.output as { title?: unknown; description?: unknown } | undefined;
    if (!description || !recording || !provenance || typeof output?.title !== "string" || typeof output.description !== "string") return false;
    const phrases = database.listRejectedPhrases();
    const text = await rewrite({ title: output.title, description: output.description }, phrases);
    if (containedPhrases([text.title, text.description], phrases).length) return false;
    if (text.title.length < 5 || text.title.length > 100 || text.description.length < 20 || text.description.length > 750) return false;
    const promptVersion = await descriptionPromptVersion(phrases);
    const updated = { ...description, promptVersion, output: { ...output, ...text } };
    const metadata = composeUploadMetadata(recording, updated, provenance, database.getArtifactPart(recordingId) ?? "full",
        { diagnosticTitle: database.getComparisonTrial() !== null });
    if (containedPhrases([metadata.title, metadata.description, ...metadata.tags], phrases).length) return false;
    database.replaceDescriptionText(recordingId, text, promptVersion, metadata,
        `description rewritten by the local model to avoid ${phrases.map((phrase) => `'${phrase}'`).join(", ")}`, now);
    return true;
}

// Apply a verdict to a metadata_ready recording before any bytes are sent.
export async function settleRejectedPhrases(
    database: PipelineDatabase,
    recordingId: string,
    provider: ActiveUploadProvider,
    now = new Date(),
    rewrite: DescriptionRewriter | null = (text, phrases) => rewriteAvoidingPhrases(text, phrases),
): Promise<RejectedPhraseVerdict> {
    const verdict = await checkRejectedPhrases(database, recordingId, provider);
    if (verdict.kind === "clean") return verdict;
    if (rewrite) {
        const rewritten = await rewriteText(database, recordingId, rewrite, now).catch((error: unknown) => {
            console.error(JSON.stringify({ event: "description-rewrite-failed", recordingId, error: String(error) }));
            return false;
        });
        if (rewritten && (await checkRejectedPhrases(database, recordingId, provider)).kind === "clean") {
            return { kind: "rewritten", phrases: verdict.phrases };
        }
    }
    if (verdict.kind === "stale_description") {
        database.returnForRedescription(recordingId,
            `${rejectedPhraseReason(provider, verdict.phrases)}; describing again with the phrases avoided`, now);
    } else {
        database.transition(recordingId, "metadata_ready", "blocked",
            `${rejectedPhraseReason(provider, verdict.phrases)}; still present after re-description, manual review required`, now);
    }
    return verdict;
}
