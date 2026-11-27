import { UPLOAD_CHECK_MILLISECONDS } from "../db/pipelineDatabase.js";
import type { PipelineDatabase } from "../db/pipelineDatabase.js";
import type { UploadOutcome, UploadRequest, ProviderUploader } from "./providerUploader.js";
import { MetadataRejectedError, TransferAbortedBeforeSubmissionError, UploadTransportError } from "sdk";
import { shutdownSignal } from "../shutdown.js";

export { UploadTransportError };


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

// How far back the destination is told about the videos this ledger created and believes
// still exist, so a short uploads list can distinguish recent uploads from older missing ones.
export const RECENT_UPLOADS_MILLISECONDS = 30 * 24 * 60 * 60_000;

// An attempt's recorded error: what the uploader threw, and whether a service stop caused it
// (the stop aborts the transfer, which then reads only "This operation was aborted").
function failureMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return shutdownSignal.aborted ? `interrupted by a service stop: ${message}` : message;
}

export class UploadCoordinator {
    constructor(
        private readonly database: PipelineDatabase,
        private readonly uploader: ProviderUploader,
    ) {}

    async uploadAdmitted(
        recordingId: string,
        reservationId: string,
        request: UploadRequest,
        now = new Date(),
    ): Promise<UploadOutcome> {
        if (request.recordingId !== recordingId) throw new Error("Upload request recording identity mismatch");
        // The destination the bytes were reserved for, unless the uploader names its own
        // (then beginUpload checks they agree).
        const provider = this.uploader.provider ?? this.database.reservationProvider(reservationId);
        const attemptId = this.database.beginUpload(recordingId, reservationId, now, provider);
        let outcome: UploadOutcome;
        try {
            outcome = await this.uploader.upload({
                ...request,
                // None when an earlier submission of this recording may have created a video
                // without a captured ID: a shortfall could then be that very copy.
                recentUploads: request.recentUploads ?? (this.database.hasUncapturedSubmission(recordingId, provider) ? []
                    : this.database.recentRemoteUploads(provider, new Date(now.getTime() - RECENT_UPLOADS_MILLISECONDS))),
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
                    error: failureMessage(error),
                }, new Date());
                this.database.releaseRetryDeadline(attemptId);
                throw error;
            }
            const transportError = error instanceof UploadTransportError ? error : null;
            const progress = this.database.getUploadProgress(attemptId);
            if ((this.uploader.creationBoundary ?? "metadata_submit") === "metadata_submit"
                && progress.phase !== "metadata_submitting") {
                // The destination creates the video only when its metadata form is
                // submitted, and that phase is recorded just before the click.
                // Failing earlier published nothing: no weekly uncertainty.
                this.database.finishUploadAttempt(attemptId, {
                    status: "failed",
                    transmittedBytes: Math.max(transportError?.transmittedBytes ?? 0, progress.transmittedBytes),
                    error: `${failureMessage(error)} (before metadata submission; no video exists)`,
                }, new Date());
                this.database.releaseRetryDeadline(attemptId);
                throw error;
            }
            // Any failure once the file upload started is acceptance-unknown:
            // the file may still land on the upload provider (or already have), so the
            // attempt must be confirmed against the uploads list instead of
            // blindly re-uploading gigabytes.
            const acceptanceUnknown = transportError?.acceptanceUnknown
                || progress.phase !== "started"
                || progress.transmittedBytes > 0;
            this.database.finishUploadAttempt(attemptId, {
                status: acceptanceUnknown ? "uncertain" : "failed",
                transmittedBytes: Math.max(transportError?.transmittedBytes ?? 0, progress.transmittedBytes),
                error: failureMessage(error),
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

        const receipt = outcome.receipt;
        const submittedAt = new Date(receipt.metadataSubmittedAt);
        if (!Number.isFinite(submittedAt.getTime())) throw new Error("Uploader returned an invalid submission timestamp");
        // Success is never decided at submit time: the attempt parks as
        // uncertain with the captured video ID, and daily reconciliation
        // verifies the public video link.
        const remoteId = receipt.submittedVideoId;
        this.database.finishUploadAttempt(attemptId, {
            status: "uncertain",
            transmittedBytes: receipt.transmittedBytes,
            remoteId: remoteId ?? undefined,
            error: remoteId
                ? "metadata submitted; awaiting daily playback verification"
                : "metadata submitted; submitted video ID was not captured",
            ...(remoteId ? { acceptedAt: submittedAt } : {}),
            confirmation: {
                confirmAfter: new Date(submittedAt.getTime() + UPLOAD_CHECK_MILLISECONDS),
            },
        }, submittedAt);
        return outcome;
    }
}
