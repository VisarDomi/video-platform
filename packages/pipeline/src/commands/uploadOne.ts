import path from "node:path";
import { assessFinalArtifact } from "shared";
import type { PipelineConfig } from "../config.js";
import { readXvideosCredentials } from "../config/secrets.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import { guardUploadIdentity, refusalMessage } from "./uploadIdentityGuard.js";
import { ChromiumXvideosUploader } from "../upload/chromiumXvideosUploader.js";
import { UploadCoordinator } from "../upload/uploadCoordinator.js";
import { verifyCurrentServerAuthority } from "../discovery/verifyCurrentAuthority.js";

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
        database.recoverInterruptedUploads();
        const recording = database.get(recordingId);
        if (!recording) {
            throw new Error(`Unknown pipeline recording ${recordingId}`);
        }
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
        const credentials = await readXvideosCredentials(config.credentialsFilePath);
        const uploader = new ChromiumXvideosUploader({
            executablePath: config.chromiumExecutablePath,
            profilePath: config.browserProfilePath,
            ...credentials,
        });
        // Backup remote check: the folder name is the local truth, the
        // edit-page title is the XVideos truth. Covers recordings admitted
        // while the network was off.
        const copy = await uploader.findUploadedCopy(path.basename(recording.sourcePath));
        if (copy.kind === "found") {
            database.parkUploadedCopy(recordingId, copy.remoteId, copy.remoteUrl);
            return {
                recordingId,
                state: database.get(recordingId)?.state,
                disposition: "parked_existing_upload",
                remoteId: copy.remoteId,
            };
        }
        if (copy.kind === "title_mismatch") {
            database.transition(recordingId, recording.state, "blocked",
                `XVideos entry ${copy.remoteId} title does not match the folder identity; manual review required`);
            throw new Error(`XVideos entry ${copy.remoteId} title does not match the folder identity; manual review required`);
        }
        if (recording.state !== "metadata_ready") {
            throw new Error(`Recording ${recordingId} is not metadata_ready`);
        }
        if (recording.sourceKind !== "edited") {
            throw new Error("Production uploads are restricted to editor/edited recordings");
        }
        await verifyCurrentServerAuthority(recording, config);
        const artifact = database.getArtifact(recordingId);
        const metadata = database.getUploadMetadata(recordingId);
        const provenance = database.getProvenance(recordingId);
        if (!artifact || !metadata || !provenance?.streamerId) throw new Error("Upload prerequisites are incomplete");
        const assessment = assessFinalArtifact({
            id: recording.id,
            path: artifact.path,
            durationSeconds: recording.durationSeconds,
            sizeBytes: artifact.sizeBytes,
        });
        if (assessment.disposition !== "ready_for_upload") {
            throw new Error(`XVideos policy blocks artifact: ${assessment.disposition}`);
        }
        const reservedBytes = artifact.sizeBytes + REQUEST_OVERHEAD_RESERVATION_BYTES;
        const reservationId = database.reserveUpload(
            recordingId,
            reservedBytes,
            new Date(),
            config.uploadTimeZone,
            config.monthlyUploadLimitBytes,
        );
        const receipt = await new UploadCoordinator(database, uploader).uploadAdmitted(
            recordingId,
            reservationId,
            {
                recordingId,
                artifactPath: artifact.path,
                sizeBytes: artifact.sizeBytes,
                title: metadata.title,
                description: metadata.description,
                tags: metadata.tags,
                visibility: "private",
                streamerAlias: provenance.alias ?? provenance.streamerId,
            },
        );
        return {
            recordingId,
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
