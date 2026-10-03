import type { PipelineDatabase } from "../db/pipelineDatabase.js";
import type { UploadOutcome, UploadRequest, XvideosUploader } from "./disabledXvideosUploader.js";
import { MetadataRejectedError, TransferAbortedBeforeSubmissionError } from "./providerWarnings.js";

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
        const provider = this.uploader.provider ?? "xvideos";
        const attemptId = this.database.beginUpload(recordingId, reservationId, now, provider);
        let outcome: UploadOutcome;
        try {
            outcome = await this.uploader.upload({
                ...request,
                onEvidence: async (evidence) => {
                    this.database.recordUploadEvidence(attemptId, evidence);
                    await request.onEvidence?.(evidence);
                },
                onProgress: async (phase, transmittedBytes) => {
                    this.database.updateUploadProgress(attemptId, phase, transmittedBytes);
                    await request.onProgress?.(phase, transmittedBytes);
                },
            });
        } catch (error) {
            if (error instanceof MetadataRejectedError) {
                // Definitive: the provider refused the form, so nothing was
                // published and there is nothing to reconcile. Bytes still count.
                this.database.recordRejectedPhrases(provider, error.phrases, attemptId);
                this.database.finishUploadAttempt(attemptId, {
                    status: "failed",
                    transmittedBytes: this.database.getUploadProgress(attemptId).transmittedBytes,
                    error: error.message,
                }, new Date());
                this.database.releaseRetryDeadline(attemptId);
                // Back to upload-ready: the next attempt's phrase check rewrites
                // the text (or, failing that, describes the video again).
                throw error;
            }
            if (error instanceof TransferAbortedBeforeSubmissionError) {
                // The metadata step never started, so no video was created:
                // a plain failed attempt, retried after the usual cooldown.
                this.database.finishUploadAttempt(attemptId, {
                    status: "failed",
                    transmittedBytes: this.database.getUploadProgress(attemptId).transmittedBytes,
                    error: error.message,
                }, new Date());
                this.database.releaseRetryDeadline(attemptId);
                throw error;
            }
            const transportError = error instanceof UploadTransportError ? error : null;
            const progress = this.database.getUploadProgress(attemptId);
            if (provider === "porntrex" && progress.phase !== "metadata_submitting") {
                // Porntrex creates the video only when its metadata form is
                // submitted, and that phase is recorded just before the click.
                // Failing earlier published nothing: no weekly uncertainty.
                this.database.finishUploadAttempt(attemptId, {
                    status: "failed",
                    transmittedBytes: Math.max(transportError?.transmittedBytes ?? 0, progress.transmittedBytes),
                    error: `${error instanceof Error ? error.message : String(error)} (before metadata submission; no video exists)`,
                }, new Date());
                this.database.releaseRetryDeadline(attemptId);
                throw error;
            }
            // Any failure once the file upload started is acceptance-unknown:
            // the file may still land on XVideos (or already have), so the
            // attempt must be confirmed against the uploads list instead of
            // blindly re-uploading gigabytes.
            const acceptanceUnknown = transportError?.acceptanceUnknown
                || progress.phase !== "started"
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
                error: `skipped re-upload; matching ${provider} entry already exists`,
                confirmation: { confirmAfter: new Date() },
            }, new Date());
            return outcome;
        }
        if (outcome.kind === "title_mismatch") {
            this.database.finishUploadAttempt(attemptId, {
                status: "failed",
                transmittedBytes: 0,
                error: `${provider} entry ${outcome.remoteId} title does not match the folder identity`,
            }, new Date());
            this.database.transition(recordingId, "metadata_ready", "blocked",
                `${provider} entry ${outcome.remoteId} title does not match the folder identity; manual review required`, new Date());
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
