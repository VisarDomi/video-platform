import type { PipelineDatabase } from "../db/pipelineDatabase.js";
import type { UploadReceipt, UploadRequest, XvideosUploader } from "./disabledXvideosUploader.js";

export class UploadTransportError extends Error {
    constructor(
        message: string,
        readonly transmittedBytes: number,
        readonly acceptanceUnknown: boolean,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = "UploadTransportError";
    }
}

export class UploadByteMeter {
    private countedBytes = 0;

    constructor(private readonly maximumBytes: number) {
        if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
            throw new Error("Upload byte limit must be a positive integer");
        }
    }

    get transmittedBytes(): number { return this.countedBytes; }

    accountWrittenBytes(bytes: number): void {
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Written bytes must be a nonnegative integer");
        if (this.countedBytes + bytes > this.maximumBytes) {
            throw new Error(`Upload byte limit would be exceeded (${this.maximumBytes})`);
        }
        this.countedBytes += bytes;
    }
}

export class UploadCoordinator {
    constructor(
        private readonly database: PipelineDatabase,
        private readonly uploader: XvideosUploader,
    ) {}

    async uploadAdmitted(
        recordingId: string,
        reservationId: string,
        request: UploadRequest,
        now = new Date(),
    ): Promise<UploadReceipt> {
        if (request.recordingId !== recordingId) throw new Error("Upload request recording identity mismatch");
        const attemptId = this.database.beginUpload(recordingId, reservationId, now);
        let receipt: UploadReceipt;
        try {
            receipt = await this.uploader.upload({
                ...request,
                onProgress: async (phase, transmittedBytes) => {
                    this.database.updateUploadProgress(attemptId, phase, transmittedBytes);
                    await request.onProgress?.(phase, transmittedBytes);
                },
            });
        } catch (error) {
            const transportError = error instanceof UploadTransportError ? error : null;
            const progress = this.database.getUploadProgress(attemptId);
            // Any failure once the file upload started is acceptance-unknown:
            // the file may still land on XVideos (or already have), so the
            // attempt must be confirmed against the uploads list instead of
            // blindly re-uploading gigabytes.
            const acceptanceUnknown = transportError?.acceptanceUnknown
                || progress.phase === "metadata_submitting"
                || progress.phase === "file_uploaded"
                || progress.transmittedBytes > 0;
            this.database.finishUploadAttempt(attemptId, {
                status: acceptanceUnknown ? "uncertain" : "failed",
                transmittedBytes: Math.max(transportError?.transmittedBytes ?? 0, progress.transmittedBytes),
                error: error instanceof Error ? error.message : String(error),
                ...(acceptanceUnknown ? {
                    confirmation: {
                        matchKey: request.matchKey,
                        confirmAfter: new Date(now.getTime() + 24 * 60 * 60_000),
                    },
                } : {}),
            }, new Date());
            throw error;
        }
        const submittedAt = new Date(receipt.metadataSubmittedAt);
        if (!Number.isFinite(submittedAt.getTime())) throw new Error("Uploader returned an invalid submission timestamp");
        if (receipt.remoteEntry) {
            this.database.finishUploadAttempt(attemptId, {
                status: "accepted",
                transmittedBytes: receipt.transmittedBytes,
                remoteId: receipt.remoteEntry.remoteId,
                remoteUrl: receipt.remoteEntry.remoteUrl,
            }, submittedAt);
            this.database.markRemoteVerified(
                recordingId,
                receipt.remoteEntry.remoteId,
                receipt.remoteEntry.remoteUrl,
                receipt.remoteEntry.moderationStatus,
                submittedAt,
            );
        } else {
            this.database.finishUploadAttempt(attemptId, {
                status: "uncertain",
                transmittedBytes: receipt.transmittedBytes,
                error: "metadata submitted; authenticated uploads-list entry not visible yet",
                confirmation: {
                    matchKey: request.matchKey,
                    confirmAfter: new Date(submittedAt.getTime() + 24 * 60 * 60_000),
                },
            }, submittedAt);
        }
        return receipt;
    }
}
