import type { PipelineDatabase } from "../db/pipelineDatabase.js";
import type { Recording } from "../domain/types.js";

// A blocked recording returns to the stage it was blocked in, a failed one is
// retried. A recording a provider removed is not unblocked while that provider
// is the active destination: it would only be uploaded there again.
export function retryRecording(database: PipelineDatabase, recordingId: string, now = new Date()): Recording {
    const recording = database.get(recordingId);
    if (!recording) throw new Error(`Recording ${recordingId} does not exist`);
    if (recording.state !== "blocked") return database.retryFailed(recordingId, now);
    const provider = database.getActiveUploadProvider();
    const removal = database.providerRemovals(recordingId).find((entry) => entry.provider === provider);
    if (removal) {
        throw new Error(`${provider} removed this recording's upload ${removal.remoteId} on ${removal.removedAt.slice(0, 10)}`
            + ` and is still the active upload provider; switch with \`npm run upload-provider:set -w pipeline -- --provider <other>\`, then retry`);
    }
    return database.retryBlocked(recordingId, now);
}
