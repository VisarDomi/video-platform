import {
    MetadataRejectedError, TransferAbortedBeforeSubmissionError, uploadErrorFromWire, UploadTransportError,
    type Destination, type DestinationEntry, type DestinationPlugin, type DestinationSession,
    type SharedSessionSnapshot, type UploadErrorWire, type UploadOutcome, type UploadRequest, type UplinkSetting,
} from "sdk";
import { RunnerConnection } from "../uplink/runnerConnection.js";
import type { CarrierLocation } from "../uplink/protocol.js";

export interface RemoteUpload {
    readonly uplink: UplinkSetting;
    readonly carrier: CarrierLocation;
    // The artifact's name in the carrier's files folder and its ledger hash.
    readonly file: { readonly name: string; readonly sha256: string };
    readonly expectedCommit: string;
    readonly stopSignal?: AbortSignal;
}

function validOutcome(value: unknown): UploadOutcome {
    const outcome = value as UploadOutcome | null;
    if (outcome?.kind === "existing" && typeof outcome.remoteId === "string" && typeof outcome.remoteUrl === "string") return outcome;
    if (outcome?.kind === "uploaded" && Number.isSafeInteger(outcome.receipt?.transmittedBytes)
        && typeof outcome.receipt.metadataSubmittedAt === "string"
        && (outcome.receipt.submittedVideoId === null || typeof outcome.receipt.submittedVideoId === "string")) return outcome;
    throw new Error("uplink: the runner's result is not an upload outcome");
}

// A destination whose uploads leave from another uplink: the runner on that network's
// machine performs the upload on the PC's shared session and reports back; everything
// else (lookups, verification, the session's upkeep) stays the PC's own destination. The
// PC records every report durably before it answers, so the reservation, the attempt, the
// creation boundary and every state transition are the unchanged code on the PC.
export class RemoteDestination implements Destination {
    readonly creationBoundary: Destination["creationBoundary"];
    readonly session: Destination["session"];

    constructor(
        private readonly local: Destination,
        private readonly plugin: DestinationPlugin,
        private readonly entry: DestinationEntry,
        private readonly stateDir: string,
        private readonly remote: RemoteUpload,
    ) {
        this.creationBoundary = local.creationBoundary;
        this.session = local.session;
    }

    findUploadedCopy(identity: string) { return this.local.findUploadedCopy(identity); }

    withSession<T>(action: (session: DestinationSession) => Promise<T>): Promise<T> { return this.local.withSession(action); }

    async upload(request: UploadRequest): Promise<UploadOutcome> {
        const config = this.entry.config ?? {};
        if (!this.plugin.readSharedSession || !this.plugin.adoptSharedSession) {
            throw new TransferAbortedBeforeSubmissionError(`uplink: destination ${this.entry.id} cannot hand its session to another uplink`);
        }
        const session: SharedSessionSnapshot | null = await this.plugin.readSharedSession(config, this.stateDir);
        if (!session) throw new TransferAbortedBeforeSubmissionError(`uplink: destination ${this.entry.id} has no shared session to hand over`);
        const { onProgress, onEvidence, artifactPath: _local, ...plain } = request;
        const connection = await RunnerConnection.open(this.remote.uplink.runner, this.remote.expectedCommit, this.remote.stopSignal)
            .catch((error: Error) => { throw new TransferAbortedBeforeSubmissionError(error.message); });
        const stop = () => connection.close();
        this.remote.stopSignal?.addEventListener("abort", stop, { once: true });
        let submitting = false;
        let bytes = 0;
        try {
            // The session travels in this line only: never in arguments, the environment or a log.
            connection.send({
                type: "upload", request: { ...plain, artifactPath: this.remote.file.name }, session,
                destination: { id: this.entry.id, plugin: this.entry.plugin, ...(this.entry.config ? { config: this.entry.config } : {}) },
                network: this.remote.uplink.network, carrier: this.remote.carrier, file: this.remote.file,
            });
            let failure: Error | null = null;
            for (;;) {
                const message = await connection.next();
                if (!message) break;
                const answer = async (record: () => Promise<void> | void) => {
                    try {
                        await record();
                        connection.send({ type: "ack", seq: message.seq });
                    } catch (error) {
                        failure ??= error instanceof Error ? error : new Error(String(error));
                        connection.send({ type: "nack", seq: message.seq, message: failure.message.slice(0, 500) });
                    }
                };
                if (message.type === "progress") {
                    await answer(async () => {
                        const phase = message.phase as "file_uploading" | "file_uploaded" | "metadata_submitting";
                        if (!["file_uploading", "file_uploaded", "metadata_submitting"].includes(phase)
                            || !Number.isSafeInteger(message.bytes) || (message.bytes as number) < 0) {
                            throw new Error("uplink: the runner reported progress the PC cannot record");
                        }
                        await onProgress?.(phase, message.bytes as number);
                        bytes = message.bytes as number;
                        if (phase === "metadata_submitting") submitting = true;
                    });
                } else if (message.type === "evidence") {
                    await answer(() => onEvidence?.(message.evidence as Record<string, unknown>));
                } else if (message.type === "session") {
                    await answer(() => this.plugin.adoptSharedSession!(config, message.session as SharedSessionSnapshot, this.stateDir));
                } else if (message.type === "result") {
                    return validOutcome(message.outcome);
                } else if (message.type === "error") {
                    const error = uploadErrorFromWire(message.error as UploadErrorWire);
                    // Once the metadata step was recorded the copy may exist: only a refused
                    // form (nothing created) stays what it is; anything else is uncertain.
                    if (submitting && !(error instanceof MetadataRejectedError)) {
                        throw new UploadTransportError(`uplink: ${error.message}`, bytes, true, { cause: error });
                    }
                    throw error;
                }
            }
            await connection.exited();
            const why = failure ? `; the PC could not record a report: ${(failure as Error).message}` : "";
            throw new UploadTransportError(`uplink: the runner ended without a result (${connection.describeEnd()})${why}`, bytes, submitting);
        } finally {
            this.remote.stopSignal?.removeEventListener("abort", stop);
            connection.close();
        }
    }
}
