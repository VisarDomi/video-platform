import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface RecordingFinalization {
    readonly status: "ready";
    readonly updatedAt: string;
}

export function readRecordingFinalization(
    databasePath: string,
    recordingPath: string,
    playlistContent: string,
): RecordingFinalization | null {
    if (!existsSync(databasePath)) return null;
    const fingerprint = createHash("sha256").update(playlistContent).digest("hex");
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
        const row = database.prepare(`
            SELECT playlist_fingerprint, report_json, updated_at
            FROM integrity_checkpoints WHERE recording_path = ?
        `).get(path.resolve(recordingPath)) as {
            playlist_fingerprint: string;
            report_json: string;
            updated_at: string;
        } | undefined;
        if (!row || row.playlist_fingerprint !== fingerprint) return null;
        const report = JSON.parse(row.report_json) as { version?: unknown; status?: unknown };
        if (report.version !== 2 || report.status !== "ready") return null;
        return { status: "ready", updatedAt: row.updated_at };
    } catch {
        return null;
    } finally {
        database.close();
    }
}
