import type { ProductionArtifactPart, RecordingProvenance } from "./types.js";

export interface ShortPart {
    readonly recordingId: string;
    readonly part: ProductionArtifactPart;
    readonly sourceFingerprint: string;
    readonly streamerKey: string;
    readonly destinationProvider: string;
    readonly aspectRatio: number;
    readonly durationSeconds: number;
    readonly playlist: string;
    readonly batchId: string | null;
    readonly verified: boolean;
}

// The streamer a short pools under: its resolved account, or, while the server cannot
// resolve it, the identifier the recording was observed under. Footage under the same
// unresolved identifier joins like a resolved streamer's and uploads with an unknown
// source; resolving it later moves its unjoined parts to the resolved key.
export function shortStreamerKey(provider: string,
    provenance: Pick<RecordingProvenance, "streamerId" | "observedIdentifier">): string {
    return provenance.streamerId ? `${provider}:${provenance.streamerId}`
        : `unresolved:${provider}:${provenance.observedIdentifier}`;
}
