import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function playlistFingerprint(content: string): string {
    return createHash("sha256").update(content).digest("hex");
}

export class FinalizationCheckpointStore {
    private readonly database: DatabaseSync;

    constructor(databasePath: string) {
        mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
        this.database = new DatabaseSync(databasePath);
        this.database.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = FULL;
            PRAGMA busy_timeout = 5000;
            CREATE TABLE IF NOT EXISTS integrity_checkpoints (
                recording_path TEXT PRIMARY KEY,
                playlist_fingerprint TEXT NOT NULL,
                report_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS finalization_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            ) STRICT;
        `);
    }

    read<T>(recordingPath: string, fingerprint: string): T | null {
        const row = this.database.prepare(`
            SELECT playlist_fingerprint, report_json
            FROM integrity_checkpoints WHERE recording_path = ?
        `).get(path.resolve(recordingPath)) as {
            playlist_fingerprint: string;
            report_json: string;
        } | undefined;
        if (!row || row.playlist_fingerprint !== fingerprint) return null;
        try {
            return JSON.parse(row.report_json) as T;
        } catch {
            return null;
        }
    }

    write(recordingPath: string, fingerprint: string, report: unknown): void {
        this.database.prepare(`
            INSERT INTO integrity_checkpoints (
                recording_path, playlist_fingerprint, report_json, updated_at
            ) VALUES (?, ?, ?, ?)
            ON CONFLICT(recording_path) DO UPDATE SET
                playlist_fingerprint = excluded.playlist_fingerprint,
                report_json = excluded.report_json,
                updated_at = excluded.updated_at
        `).run(path.resolve(recordingPath), fingerprint, JSON.stringify(report), new Date().toISOString());
    }

    clear(recordingPath: string): void {
        this.database.prepare("DELETE FROM integrity_checkpoints WHERE recording_path = ?")
            .run(path.resolve(recordingPath));
    }

    setMeta(key: string, value: unknown): void {
        this.database.prepare(`
            INSERT INTO finalization_meta (key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(key, JSON.stringify(value), new Date().toISOString());
    }

    getMeta<T>(key: string): T | null {
        const row = this.database.prepare("SELECT value FROM finalization_meta WHERE key = ?")
            .get(key) as { value: string } | undefined;
        if (!row) return null;
        try {
            return JSON.parse(row.value) as T;
        } catch {
            return null;
        }
    }

    close(): void {
        this.database.close();
    }
}
