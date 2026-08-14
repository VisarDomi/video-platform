import { assessFinalArtifact } from "shared";
import type { PipelineConfig } from "../config.js";
import { readXvideosCredentials } from "../config/secrets.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import { ChromiumXvideosUploader } from "../upload/chromiumXvideosUploader.js";
import { UploadCoordinator } from "../upload/uploadCoordinator.js";
import { verifyCurrentServerAuthority } from "../discovery/verifyCurrentAuthority.js";

export const REQUEST_OVERHEAD_RESERVATION_BYTES = 16 * 1024 * 1024;

export async function uploadOne(
    recordingId: string,
    config: PipelineConfig,
    options: { readonly modelSelection?: "manual" | "automatic-known" } = {},
): Promise<unknown> {
    if (!config.networkUploadsEnabled) {
        throw new Error("Network uploads are disabled; explicit VIDEO_PIPELINE_NETWORK_UPLOADS=1 opt-in is required");
    }
    const database = new PipelineDatabase(config.databasePath);
    try {
        database.recoverInterruptedUploads();
        const recording = database.get(recordingId);
        if (!recording || recording.state !== "metadata_ready") {
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
        const model = database.getStreamerModel(recording.provider, provenance.streamerId);
        if (!model) throw new Error(`Streamer model needs review for ${recording.provider}:${provenance.streamerId}`);
        const credentials = await readXvideosCredentials(config.credentialsFilePath);
        const uploader = new ChromiumXvideosUploader({
            executablePath: config.chromiumExecutablePath,
            profilePath: config.browserProfilePath,
            ...credentials,
        });
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
                matchKey: metadata.matchKey,
                visibility: "private",
                model: {
                    stageName: model.stageName,
                    gender: model.gender,
                    howKnown: model.howKnown,
                    profilePicture: model.profilePicture,
                    xvideosModelId: model.xvideosModelId,
                    selectionMode: options.modelSelection ?? "manual",
                },
            },
        );
        if (!model.xvideosModelId && receipt.selectedModelId) {
            database.setRemoteModelId(recording.provider, provenance.streamerId, receipt.selectedModelId);
        }
        return {
            recordingId,
            state: database.get(recordingId)?.state,
            transmittedBytes: receipt.transmittedBytes,
            remoteEntry: receipt.remoteEntry,
            confirmAfter: receipt.remoteEntry ? null : new Date(
                new Date(receipt.metadataSubmittedAt).getTime() + 24 * 60 * 60_000,
            ).toISOString(),
        };
    } finally {
        database.close();
    }
}
