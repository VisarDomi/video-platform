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
        try {
            const receipt = await this.uploader.upload(request);
            this.database.finishUploadAttempt(attemptId, {
                status: "accepted",
                transmittedBytes: receipt.transmittedBytes,
                remoteId: receipt.remoteId,
                remoteUrl: receipt.remoteUrl,
            }, now);
            return receipt;
        } catch (error) {
            const transportError = error instanceof UploadTransportError ? error : null;
            this.database.finishUploadAttempt(attemptId, {
                status: transportError?.acceptanceUnknown ? "uncertain" : "failed",
                transmittedBytes: transportError?.transmittedBytes ?? 0,
                error: error instanceof Error ? error.message : String(error),
            }, now);
            throw error;
        }
    }
}
