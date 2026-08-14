import { promises as fs } from "node:fs";

import type { PipelineConfig } from "../config.js";
import type { Recording, RecordingInput } from "../domain/types.js";
import { inspectFinalizedRecording } from "./inspectRecording.js";
import { readRecordingFinalization } from "./recordingFinalization.js";

export async function verifyCurrentServerAuthority(
    recording: Recording,
    config: PipelineConfig,
): Promise<RecordingInput> {
    const inspection = await inspectFinalizedRecording(
        recording.sourcePath,
        recording.provider,
        recording.sourceKind,
    );
    if (inspection.status !== "finalized") {
        throw new Error(`Current source is not finalized: ${inspection.reason}`);
    }
    const playlist = await fs.readFile(inspection.recording.playlistPath, "utf8");
    if (!readRecordingFinalization(
        config.finalizationDatabasePath,
        recording.sourcePath,
        playlist,
    )) throw new Error("Current source lacks an exact ready server checkpoint");
    if (inspection.recording.sourceFingerprint !== recording.sourceFingerprint) {
        throw new Error("Edited source changed after pipeline admission; manual re-admission is required");
    }
    return inspection.recording;
}
