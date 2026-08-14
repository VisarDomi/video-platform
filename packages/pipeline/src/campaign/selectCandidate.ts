import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { PipelineDatabase } from "../db/pipelineDatabase.js";
import type { CampaignProviderFilter, RecordingInput } from "../domain/types.js";
import type { DiscoveryRoot } from "../discovery/inspectRecording.js";
import { inspectFinalizedRecording } from "../discovery/inspectRecording.js";
import { readRecordingFinalization } from "../discovery/recordingFinalization.js";

interface CheckpointRow {
    recording_path: string;
    report_json: string;
}

interface CandidatePath {
    readonly recordingPath: string;
    readonly root: DiscoveryRoot;
    readonly captureKey: string;
}

export function captureKeyFromFolderName(folderName: string): string | null {
    const match = folderName.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2})(\d{2})(\d{2})(?:\s|$)/);
    if (!match) return null;
    const [, year, month, day, hour, minute, second] = match;
    const candidate = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
    if (!Number.isFinite(candidate.getTime())
        || candidate.getUTCFullYear() !== Number(year)
        || candidate.getUTCMonth() + 1 !== Number(month)
        || candidate.getUTCDate() !== Number(day)
        || candidate.getUTCHours() !== Number(hour)
        || candidate.getUTCMinutes() !== Number(minute)
        || candidate.getUTCSeconds() !== Number(second)) return null;
    return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

function managedCandidate(
    recordingPath: string,
    roots: readonly DiscoveryRoot[],
    providerFilter: CampaignProviderFilter,
): CandidatePath | null {
    const resolved = path.resolve(recordingPath);
    const root = roots.find((candidate) => candidate.sourceKind === "edited"
        && path.resolve(candidate.path) === path.dirname(resolved)
        && (providerFilter === "all" || candidate.provider === providerFilter));
    if (!root || path.basename(resolved).startsWith(".")) return null;
    const captureKey = captureKeyFromFolderName(path.basename(resolved));
    return captureKey ? { recordingPath: resolved, root, captureKey } : null;
}

export async function selectOldestFinalizedEditedCandidate(options: {
    readonly finalizationDatabasePath: string;
    readonly roots: readonly DiscoveryRoot[];
    readonly providerFilter: CampaignProviderFilter;
    readonly pipelineDatabase: PipelineDatabase;
}): Promise<RecordingInput | null> {
    const database = new DatabaseSync(options.finalizationDatabasePath, { readOnly: true });
    let rows: CheckpointRow[];
    try {
        rows = database.prepare(`
            SELECT recording_path, report_json FROM integrity_checkpoints
            ORDER BY recording_path
        `).all() as unknown as CheckpointRow[];
    } finally {
        database.close();
    }
    const candidates = rows.flatMap((row) => {
        try {
            const report = JSON.parse(row.report_json) as { version?: unknown; status?: unknown };
            if (report.version !== 2 || report.status !== "ready") return [];
        } catch {
            return [];
        }
        const candidate = managedCandidate(row.recording_path, options.roots, options.providerFilter);
        return candidate && !options.pipelineDatabase.getBySourcePath(candidate.recordingPath) ? [candidate] : [];
    }).sort((left, right) => left.captureKey.localeCompare(right.captureKey)
        || left.root.provider.localeCompare(right.root.provider)
        || left.recordingPath.localeCompare(right.recordingPath));

    for (const candidate of candidates) {
        const inspection = await inspectFinalizedRecording(
            candidate.recordingPath,
            candidate.root.provider,
            "edited",
        );
        if (inspection.status !== "finalized") continue;
        const playlist = await fs.readFile(inspection.recording.playlistPath, "utf8");
        if (!readRecordingFinalization(
            options.finalizationDatabasePath,
            candidate.recordingPath,
            playlist,
        )) continue;
        return inspection.recording;
    }
    return null;
}
