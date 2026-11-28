import type { RecordingProvenance } from "../domain/types.js";

// Keep unresolved identity honest in SQLite. Only the public reference gets
// a placeholder; never invent a provider account or model alias. Every
// unresolved reason uploads: the server not knowing the identifier, the
// current catalog not listing it, or its site giving no pages.
export function allowsPlaceholder(provenance: RecordingProvenance | null): boolean {
    return provenance?.status === "review_required";
}

export function allowsUpload(provenance: RecordingProvenance | null): boolean {
    return !!provenance && (allowsPlaceholder(provenance) || !!provenance.streamerUrl);
}
