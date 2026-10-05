import type { PipelineDatabase } from "../db/pipelineDatabase.js";
import type {
    ArtifactRecord,
    ProductionArtifactPart,
    Recording,
} from "../domain/types.js";
import { composeUploadMetadata } from "../metadata/composeUploadMetadata.js";
import { allowsUpload } from "../provenance/uploadPolicy.js";

export interface DescriptionEvidence {
    readonly artifactSha256: string;
    readonly promptVersion: string;
    readonly fps: number;
    readonly output: unknown;
    readonly evidencePath: string;
}

export interface AutomaticProductionArtifact extends Omit<ArtifactRecord, "recordingId"> {
    readonly part: Exclude<ProductionArtifactPart, "full">;
    readonly segmentCount: number;
    readonly sourceDimensions: readonly string[];
}

// A shape split's piece too short to upload; kept for a person to handle.
export interface ManualPiece {
    readonly part: ProductionArtifactPart;
    readonly segmentIndexes: readonly number[];
    readonly durationSeconds: number;
    readonly sourceDimensions: readonly string[];
}

export type RemuxStageResult = string | {
    readonly disposition: "artifact";
    readonly path: string;
    readonly eventReason: string;
} | {
    readonly disposition: "artifact_set";
    readonly reason: string;
    readonly primary: AutomaticProductionArtifact;
    readonly queued: readonly AutomaticProductionArtifact[];
    readonly manualPieces?: readonly ManualPiece[];
} | {
    // Nothing long enough to upload: every piece waits for a person.
    readonly disposition: "manual";
    readonly reason: string;
    readonly manualPieces: readonly ManualPiece[];
};

export interface PipelineStages {
    remux(recording: Recording): Promise<RemuxStageResult>;
    validateArtifact(recording: Recording, artifactPath: string): Promise<Omit<ArtifactRecord, "recordingId">>;
    describe(recording: Recording, artifact: ArtifactRecord, avoidPhrases: readonly string[]): Promise<DescriptionEvidence>;
}

export class PipelineOrchestrator {
    constructor(
        private readonly database: PipelineDatabase,
        private readonly stages: PipelineStages,
        private readonly workerId: string,
        // Every recording is converted (slow preset, CRF 16): about 2.4x its
        // duration, and a recording may be up to two hours. Keep it owned
        // through the longest supported local stage.
        private readonly leaseMilliseconds = 12 * 60 * 60_000,
    ) {}

    async processOne(now = new Date()): Promise<Recording | null> {
        const recording = this.database.claimNext(
            ["server_ready", "remuxed", "artifact_valid", "described"],
            this.workerId,
            this.leaseMilliseconds,
            now,
            ["edited"],
        );
        if (!recording) return null;
        return await this.processClaimed(recording);
    }

    async processRecording(id: string, now = new Date()): Promise<Recording | null> {
        const recording = this.database.claimRecording(
            id,
            ["server_ready", "remuxed", "artifact_valid", "described"],
            this.workerId,
            this.leaseMilliseconds,
            now,
            ["edited"],
        );
        if (!recording) return null;
        return await this.processClaimed(recording);
    }

    private async processClaimed(recording: Recording): Promise<Recording> {
        let result: Recording;
        try {
            switch (recording.state) {
                case "server_ready": {
                    const remux = await this.stages.remux(recording);
                    if (typeof remux === "string") {
                        result = this.database.saveRemuxOutput(recording.id, remux);
                    } else if (remux.disposition === "artifact") {
                        result = this.database.saveRemuxOutput(
                            recording.id,
                            remux.path,
                            new Date(),
                            remux.eventReason,
                        );
                    } else if (remux.disposition === "artifact_set") {
                        if (remux.manualPieces?.length) this.database.recordManualPieces(recording.id, remux.manualPieces, remux.reason);
                        result = this.database.saveProductionArtifactSet(
                            recording.id,
                            remux.primary,
                            remux.queued,
                            remux.reason,
                        );
                    } else if (remux.disposition === "manual") {
                        this.database.recordManualPieces(recording.id, remux.manualPieces, remux.reason);
                        result = this.database.transition(recording.id, "server_ready", "blocked", remux.reason);
                    } else {
                        throw new Error("Unsupported remux stage result");
                    }
                    break;
                }
                case "remuxed": {
                    const artifactPath = this.database.getRemuxOutput(recording.id);
                    if (!artifactPath) throw new Error("Remuxed recording has no adoptable artifact path");
                    const artifact = await this.stages.validateArtifact(recording, artifactPath);
                    result = this.database.saveArtifact(recording.id, artifact);
                    break;
                }
                case "artifact_valid": {
                    const artifact = this.database.getArtifact(recording.id);
                    if (!artifact) throw new Error("Valid recording has no artifact metadata");
                    // Every provider's rejected phrases: avoiding them costs nothing elsewhere.
                    const description = await this.stages.describe(recording, artifact, this.database.listRejectedPhrases());
                    result = this.database.saveDescription(recording.id, description);
                    break;
                }
                case "described": {
                    const description = this.database.getDescription(recording.id);
                    const provenance = this.database.getProvenance(recording.id);
                    if (!description) throw new Error("Described recording has no description evidence");
                    if (!provenance || !allowsUpload(provenance)) {
                        result = this.database.markProvenanceReviewRequired(
                            recording.id,
                            provenance?.reason ?? "recording provenance has not been resolved",
                        );
                        break;
                    }
                    result = this.database.saveUploadMetadata(
                        recording.id,
                        composeUploadMetadata(
                            recording,
                            description,
                            provenance,
                            this.database.getArtifactPart(recording.id) ?? "full",
                            { diagnosticTitle: this.database.getComparisonTrial() !== null },
                        ),
                    );
                    break;
                }
                default:
                    result = recording;
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            result = this.database.transition(recording.id, recording.state, "failed", message);
        } finally {
            const current = this.database.get(recording.id);
            if (current?.leaseOwner === this.workerId) this.database.releaseLease(recording.id, this.workerId);
        }
        return this.database.get(result.id) ?? result;
    }
}
