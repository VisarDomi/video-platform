import type { RecordingProvenance } from "../domain/types.js";

// Keep unresolved identity honest in SQLite. Only the public reference gets
// a placeholder; never invent a provider account or model alias.
export function allowsPlaceholder(provenance: RecordingProvenance | null): boolean {
    return provenance?.status === "review_required"
        && ["identifier_not_resolved_by_server", "identifier_not_resolved_by_current_target_catalog"]
            .includes(provenance.reason ?? "");
}

export function allowsUpload(provenance: RecordingProvenance | null): boolean {
    return !!provenance && (allowsPlaceholder(provenance)
        || (provenance.status !== "review_required" && !!provenance.streamerUrl));
}
