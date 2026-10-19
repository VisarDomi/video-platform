import { promises as fs } from "node:fs";

import type { PipelineConfig } from "../config.js";
import type { Recording, RecordingInput } from "../domain/types.js";
import { inspectFinalizedRecording } from "./inspectRecording.js";
import { readRecordingFinalization } from "./recordingFinalization.js";
import type { PipelineDatabase } from "../db/pipelineDatabase.js";

export async function verifyCurrentServerAuthority(
    recording: Recording,
    config: PipelineConfig,
    database?: PipelineDatabase,
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
    const members = database?.shortParts(undefined, recording.id) ?? [];
    if (members.length) {
        if (inspection.recording.sourceFingerprint !== recording.sourceFingerprint) throw new Error("Joined source changed after admission");
        for (const part of members) {
            const member = database!.get(part.recordingId);
            if (!member || member.provider !== recording.provider || member.sourceFingerprint !== part.sourceFingerprint
                || database!.shortParts(undefined, member.id).length) throw new Error("Invalid joined member identity");
            const provenance = database!.getProvenance(member.id);
            if (`${member.provider}:${provenance?.streamerId}` !== part.streamerKey) throw new Error("Joined member streamer changed");
            await verifyCurrentServerAuthority(member, config);
        }
        return inspection.recording;
    }
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
