import { access, unlink } from "node:fs/promises";
import type { PipelineConfig } from "../config.js";
import type { PipelineDatabase } from "../db/pipelineDatabase.js";

const SWEEP_MIN_AGE_MILLISECONDS = 24 * 60 * 60_000;
const IN_FLIGHT_STATES = ["xvideos_admitted", "xvideos_uploading"];

// Disk is the truth: a recording whose source folder no longer exists is
// forgotten entirely — ledger rows, confirmations, verifications — together
// with the pipeline-owned files (staging artifact, remux output, descriptor
// evidence). ISP billing (bandwidth_events) is never refunded and never
// deleted. Rows younger than 24 hours and in-flight uploads are skipped.
export async function sweepMissingRecordings(
    database: PipelineDatabase,
    config: Pick<PipelineConfig, "cleanupEnabled">,
    now = new Date(),
): Promise<Array<{ recordingId: string; provider: string; reason: string }>> {
    if (!config.cleanupEnabled) return [];
    const swept: Array<{ recordingId: string; provider: string; reason: string }> = [];
    for (const recording of database.list()) {
        if (IN_FLIGHT_STATES.includes(recording.state)) continue;
        if (recording.leaseOwner) continue;
        const createdAt = new Date(recording.createdAt).getTime();
        if (!Number.isFinite(createdAt) || now.getTime() - createdAt < SWEEP_MIN_AGE_MILLISECONDS) continue;
        try {
            await access(recording.sourcePath);
            continue;
        } catch {
            // folder is gone
        }
        const artifact = database.getArtifact(recording.id);
        if (artifact) await unlink(artifact.path).catch(() => undefined);
        const remuxOutput = database.getRemuxOutput(recording.id);
        if (remuxOutput) await unlink(remuxOutput).catch(() => undefined);
        const description = database.getDescription(recording.id);
        if (description) {
            const stillReferenced = database.list()
                .some((other) => other.id !== recording.id
                    && database.getDescription(other.id)?.evidencePath === description.evidencePath);
            if (!stillReferenced) await unlink(description.evidencePath).catch(() => undefined);
        }
        database.deleteRecording(recording.id);
        swept.push({ recordingId: recording.id, provider: recording.provider, reason: "source folder missing from disk" });
    }
    return swept;
}
