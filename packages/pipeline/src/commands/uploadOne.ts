import { assessFinalArtifact, policyForUploadProvider } from "shared";
import type { PipelineConfig } from "../config.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import { guardUploadIdentity, refusalMessage } from "./uploadIdentityGuard.js";
import { createProviderUploader } from "../upload/providerFactory.js";
import { UploadCoordinator } from "../upload/uploadCoordinator.js";
import { verifyCurrentServerAuthority } from "../discovery/verifyCurrentAuthority.js";
import { RESOLUTION_POLICY_VERSION } from "../stages/resolutionPolicy.js";
import { productionUploadIdentity } from "../metadata/composeUploadMetadata.js";
import { CURRENT_PRODUCTION_VERSION } from "../domain/productionVersion.js";
import { isDirectArtifactPath } from "../stages/remux.js";
import { allowsUpload } from "../provenance/uploadPolicy.js";
import { settleRejectedPhrases } from "../metadata/rejectedPhraseCheck.js";

export const REQUEST_OVERHEAD_RESERVATION_BYTES = 16 * 1024 * 1024;

export async function uploadOne(
    recordingId: string,
    config: PipelineConfig,
): Promise<unknown> {
    if (!config.networkUploadsEnabled) {
        throw new Error("Network uploads are disabled; explicit VIDEO_PIPELINE_NETWORK_UPLOADS=1 opt-in is required");
    }
    const database = new PipelineDatabase(config.databasePath);
    try {
        const provider = config.uploadProvider ?? database.getActiveUploadProvider();
        if (database.getProductionVersion() !== CURRENT_PRODUCTION_VERSION) {
            throw new Error(`Upload requires active ${CURRENT_PRODUCTION_VERSION}; resume the campaign rollover first`);
        }
        database.recoverInterruptedUploads();
        const recording = database.get(recordingId);
        if (!recording) {
            throw new Error(`Unknown pipeline recording ${recordingId}`);
        }
        if ((config.comparisonTrialOnly || database.getComparisonTrial()) && !database.comparisonAllows(recording)) {
            throw new Error("Upload refused: recording is not in the explicit comparison selection");
        }
        if (!database.hasResolutionPolicyAssessment(recordingId, RESOLUTION_POLICY_VERSION)) {
            throw new Error(
                `Recording ${recordingId} has not passed ${RESOLUTION_POLICY_VERSION}; run it through the campaign before upload`,
            );
        }
        const identityOutcome = await guardUploadIdentity(database, recording, config);
        if (identityOutcome.kind === "verified_cleaned" || identityOutcome.kind === "verified_retained") {
            return {
                recordingId,
                state: database.get(recordingId)?.state,
                disposition: `already_${identityOutcome.kind}`,
                remoteId: identityOutcome.remoteId,
            };
        }
        if (identityOutcome.kind === "unverified_refused") {
            throw new Error(refusalMessage(identityOutcome));
        }
        if (recording.state !== "metadata_ready") {
            throw new Error(`Recording ${recordingId} is not metadata_ready`);
        }
        if (recording.sourceKind !== "edited") {
            throw new Error("Production uploads are restricted to edited recordings");
        }
        await verifyCurrentServerAuthority(recording, config);
        const artifact = database.getArtifact(recordingId);
        const artifactPart = database.getArtifactPart(recordingId) ?? "full";
        const metadata = database.getUploadMetadata(recordingId);
        const provenance = database.getProvenance(recordingId);
        if (!artifact || !metadata || !provenance || !allowsUpload(provenance)) throw new Error("Upload prerequisites are incomplete");
        if (!isDirectArtifactPath(config.stagingRoot, artifact.path)) {
            throw new Error(
                `Artifact ${artifact.path} does not belong to active ${CURRENT_PRODUCTION_VERSION} staging`,
            );
        }
        const assessment = assessFinalArtifact({
            id: recording.id,
            path: artifact.path,
            durationSeconds: recording.durationSeconds,
            sizeBytes: artifact.sizeBytes,
        }, policyForUploadProvider(provider));
        if (assessment.disposition !== "ready_for_upload") {
            const reason = `${provider}: ${assessment.disposition}; ${assessment.notification?.message ?? "manual review required"}`;
            database.transition(recordingId, "metadata_ready", "blocked", reason);
            return { recordingId, uploadProvider: provider, state: "blocked", disposition: "manual_review", reason };
        }
        const phrases = await settleRejectedPhrases(database, recordingId, provider);
        if (phrases.kind !== "clean") {
            return { recordingId, uploadProvider: provider, state: database.get(recordingId)?.state,
                disposition: phrases.kind === "stale_description" ? "redescribe_rejected_phrases" : "manual_review",
                rejectedPhrases: phrases.phrases };
        }
        // Copies on any synchronized provider account (including manual and
        // older-generation uploads) come from the database, never a login.
        const copies = database.findProviderInventoryCopies(recordingId);
        if (copies.length) {
            const reason = `already on ${copies.map((copy) => `${copy.provider} ${copy.remoteId} (${copy.status})`).join(", ")}`
                + " per the synchronized provider inventory; not uploading again, manual review required";
            database.transition(recordingId, "metadata_ready", "blocked", reason);
            return { recordingId, uploadProvider: provider, state: "blocked", disposition: "manual_review", reason };
        }
        const uploader = await createProviderUploader(config, provider);
        const reservedBytes = artifact.sizeBytes + REQUEST_OVERHEAD_RESERVATION_BYTES;
        const reservationId = database.reserveUpload(
            recordingId,
            reservedBytes,
            new Date(),
            config.uploadTimeZone,
            config.monthlyUploadLimitBytes,
            provider,
        );
        const outcome = await new UploadCoordinator(database, uploader).uploadAdmitted(
            recordingId,
            reservationId,
            {
                recordingId,
                uploadIdentity: productionUploadIdentity(recording, artifactPart),
                artifactPath: artifact.path,
                sizeBytes: artifact.sizeBytes,
                title: metadata.title,
                description: metadata.description,
                tags: metadata.tags,
                visibility: provider === "porntrex" ? "public" : "private",
                lookupBeforeUpload: database.hasUploadAttempt(recordingId),
                streamerAlias: provenance.alias ?? provenance.streamerId ?? undefined,
            },
        );
        if (outcome.kind === "existing") {
            return {
                recordingId,
                state: database.get(recordingId)?.state,
                disposition: "parked_existing_upload",
                remoteId: outcome.remoteId,
            };
        }
        if (outcome.kind === "title_mismatch") {
            throw new Error(`${provider} entry ${outcome.remoteId} title does not match the folder identity; manual review required`);
        }
        const receipt = outcome.receipt;
        return {
            recordingId,
            uploadProvider: provider,
            state: database.get(recordingId)?.state,
            transmittedBytes: receipt.transmittedBytes,
            confirmAfter: new Date(
                new Date(receipt.metadataSubmittedAt).getTime() + 24 * 60 * 60_000,
            ).toISOString(),
        };
    } finally {
        database.close();
    }
}
