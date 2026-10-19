import type { ProductionArtifactPart } from "./types.js";

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
