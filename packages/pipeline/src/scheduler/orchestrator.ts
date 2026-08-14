import type { PipelineDatabase } from "../db/pipelineDatabase.js";
import type { ArtifactRecord, Recording } from "../domain/types.js";
import { composeUploadMetadata } from "../metadata/composeUploadMetadata.js";

export interface DescriptionEvidence {
    readonly artifactSha256: string;
    readonly promptVersion: string;
    readonly fps: number;
    readonly output: unknown;
    readonly evidencePath: string;
}

export interface PipelineStages {
    remux(recording: Recording): Promise<string>;
    validateArtifact(recording: Recording, artifactPath: string): Promise<Omit<ArtifactRecord, "recordingId">>;
    describe(recording: Recording, artifact: ArtifactRecord): Promise<DescriptionEvidence>;
}

export class PipelineOrchestrator {
    constructor(
        private readonly database: PipelineDatabase,
        private readonly stages: PipelineStages,
        private readonly workerId: string,
        private readonly leaseMilliseconds = 30 * 60_000,
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
                    const artifactPath = await this.stages.remux(recording);
                    result = this.database.saveRemuxOutput(recording.id, artifactPath);
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
                    const description = await this.stages.describe(recording, artifact);
                    result = this.database.saveDescription(recording.id, description);
                    break;
                }
                case "described": {
                    const description = this.database.getDescription(recording.id);
                    const provenance = this.database.getProvenance(recording.id);
                    if (!description) throw new Error("Described recording has no description evidence");
                    if (!provenance || provenance.status === "review_required") {
                        result = this.database.markProvenanceReviewRequired(
                            recording.id,
                            provenance?.reason ?? "recording provenance has not been resolved",
                        );
                        break;
                    }
                    result = this.database.saveUploadMetadata(
                        recording.id,
                        composeUploadMetadata(recording, description, provenance),
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
