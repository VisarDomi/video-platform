import type { PipelineConfig } from "../config.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import { guardUploadIdentity, refusalMessage } from "./uploadIdentityGuard.js";
import { TargetCatalogResolver } from "../provenance/targetResolver.js";
import { PipelineOrchestrator } from "../scheduler/orchestrator.js";
import { createDefaultStages } from "../stages/defaultStages.js";
import { verifyCurrentServerAuthority } from "../discovery/verifyCurrentAuthority.js";

export async function describeOne(recordingId: string, config: PipelineConfig): Promise<unknown> {
    const database = new PipelineDatabase(config.databasePath);
    try {
        const recording = database.get(recordingId);
        if (!recording) throw new Error(`Unknown pipeline recording ${recordingId}`);
        const identityOutcome = await guardUploadIdentity(database, recording, config);
        if (identityOutcome.kind === "verified_cleaned") {
            return {
                recordingId,
                state: database.get(recordingId)?.state,
                disposition: "already_verified_cleaned",
                remoteId: identityOutcome.remoteId,
            };
        }
        if (identityOutcome.kind === "unverified_refused") {
            throw new Error(refusalMessage(identityOutcome));
        }
        if (recording.sourceKind !== "edited") {
            throw new Error("Durable upload metadata is restricted to edited recordings");
        }
        if (recording.state !== "artifact_valid" && recording.state !== "described"
            && recording.state !== "provenance_review_required" && recording.state !== "metadata_ready") {
            throw new Error(`Recording cannot be described from pipeline state ${recording.state}`);
        }
        if (recording.state === "metadata_ready" || recording.state === "provenance_review_required") {
            return {
                recordingId,
                state: recording.state,
                description: database.getDescription(recordingId),
                provenance: database.getProvenance(recordingId),
                metadata: database.getUploadMetadata(recordingId),
            };
        }
        await verifyCurrentServerAuthority(recording, config);

        const resolver = TargetCatalogResolver.load({ serverUrl: config.serverUrl });
        const resolution = await resolver.resolve(recording);
        database.saveProvenance(recordingId,
            database.getProvenanceOverride(recording.provider, resolution.observedIdentifier) ?? resolution);
        const orchestrator = new PipelineOrchestrator(
            database,
            createDefaultStages(config.stagingRoot),
            `pipeline-describe-one-${process.pid}`,
        );
        let current = recording;
        if (current.state === "artifact_valid") {
            current = await orchestrator.processRecording(recordingId) ?? database.get(recordingId) ?? current;
        }
        if (current.state === "described") {
            current = await orchestrator.processRecording(recordingId) ?? database.get(recordingId) ?? current;
        }
        return {
            recordingId,
            state: current.state,
            description: database.getDescription(recordingId),
            provenance: database.getProvenance(recordingId),
            metadata: database.getUploadMetadata(recordingId),
        };
    } finally {
        database.close();
    }
}
