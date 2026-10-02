import { assessFinalArtifact, policyForUploadProvider } from "shared";
import type { PipelineConfig } from "../config.js";
import { activeUploadProvider } from "../config.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import { guardUploadIdentity, refusalMessage } from "./uploadIdentityGuard.js";
import { createProviderUploader } from "../upload/providerFactory.js";
import { UploadCoordinator } from "../upload/uploadCoordinator.js";
import { verifyCurrentServerAuthority } from "../discovery/verifyCurrentAuthority.js";
import { RESOLUTION_POLICY_VERSION } from "../stages/resolutionPolicy.js";
import { productionUploadIdentity, uploadLookupIdentity } from "../metadata/composeUploadMetadata.js";
import { CURRENT_PRODUCTION_VERSION } from "../domain/productionVersion.js";
import { isDirectArtifactPath } from "../stages/remux.js";
import { allowsUpload } from "../provenance/uploadPolicy.js";
import { checkXvideosBeforePorntrex } from "../upload/crossProviderIdentityGuard.js";

export const REQUEST_OVERHEAD_RESERVATION_BYTES = 16 * 1024 * 1024;

export async function uploadOne(
    recordingId: string,
    config: PipelineConfig,
): Promise<unknown> {
    if (!config.networkUploadsEnabled) {
        throw new Error("Network uploads are disabled; explicit VIDEO_PIPELINE_NETWORK_UPLOADS=1 opt-in is required");
    }
    const provider = activeUploadProvider(config);
    const database = new PipelineDatabase(config.databasePath);
    try {
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
        if (provider === "porntrex") {
            // The local ledger covers managed uploads; this read-only guard
            // also covers older/manual XVideos uploads not yet synchronized.
            // An unavailable/ambiguous lookup is never treated as absence.
            const identity = uploadLookupIdentity(recording, artifactPart, metadata.title);
            if (!identity) throw new Error("Cross-provider duplicate check lacks a filename identity");
            const existing = await checkXvideosBeforePorntrex(database, recordingId, identity, config);
            if (existing) return existing;
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
