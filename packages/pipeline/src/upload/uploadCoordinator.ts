import type { PipelineDatabase } from "../db/pipelineDatabase.js";
import type { UploadOutcome, UploadRequest, XvideosUploader } from "./disabledXvideosUploader.js";

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
    ): Promise<UploadOutcome> {
        if (request.recordingId !== recordingId) throw new Error("Upload request recording identity mismatch");
        const attemptId = this.database.beginUpload(recordingId, reservationId, now);
        let outcome: UploadOutcome;
        try {
            outcome = await this.uploader.upload({
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
                        confirmAfter: new Date(now.getTime() + 24 * 60 * 60_000),
                    },
                } : {}),
            }, new Date());
            throw error;
        }
        if (outcome.kind === "existing") {
            this.database.finishUploadAttempt(attemptId, {
                status: "uncertain",
                transmittedBytes: 0,
                remoteId: outcome.remoteId,
                remoteUrl: outcome.remoteUrl,
                error: "skipped re-upload; matching XVideos entry already exists",
                confirmation: { confirmAfter: new Date() },
            }, new Date());
            return outcome;
        }
        if (outcome.kind === "title_mismatch") {
            this.database.finishUploadAttempt(attemptId, {
                status: "failed",
                transmittedBytes: 0,
                error: `XVideos entry ${outcome.remoteId} title does not match the folder identity`,
            }, new Date());
            this.database.transition(recordingId, "metadata_ready", "blocked",
                `XVideos entry ${outcome.remoteId} title does not match the folder identity; manual review required`, new Date());
            return outcome;
        }
        const receipt = outcome.receipt;
        const submittedAt = new Date(receipt.metadataSubmittedAt);
        if (!Number.isFinite(submittedAt.getTime())) throw new Error("Uploader returned an invalid submission timestamp");
        // Success is never decided at submit time: the attempt parks as
        // uncertain with the captured video ID, and the 24-hour reconcile
        // verifies the public video link.
        const remoteId = receipt.submittedVideoId;
        this.database.finishUploadAttempt(attemptId, {
            status: "uncertain",
            transmittedBytes: receipt.transmittedBytes,
            remoteId: remoteId ?? undefined,
            error: remoteId
                ? "metadata submitted; awaiting 24-hour edit-page verification"
                : "metadata submitted; submitted video ID was not captured",
            confirmation: {
                confirmAfter: new Date(submittedAt.getTime() + 24 * 60 * 60_000),
            },
        }, submittedAt);
        return outcome;
    }
}
