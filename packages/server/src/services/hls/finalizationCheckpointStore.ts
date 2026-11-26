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
            PRAGMA busy_timeout = 5000;
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = FULL;
            PRAGMA cache_size = -16000;
            PRAGMA temp_store = MEMORY;
            PRAGMA wal_autocheckpoint = 1000;
            CREATE TABLE IF NOT EXISTS integrity_checkpoints (
                recording_path TEXT PRIMARY KEY,
                playlist_fingerprint TEXT NOT NULL,
                report_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            ) STRICT;
            CREATE INDEX IF NOT EXISTS integrity_checkpoints_updated_idx
                ON integrity_checkpoints (updated_at);
            CREATE TABLE IF NOT EXISTS finalization_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS media_repairs (
                recording_path TEXT PRIMARY KEY,
                plan_json TEXT NOT NULL,
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

    // A move keeps the playlist byte for byte, so a ready checkpoint still holds for the folder
    // at its new path. Writes it there (before the move; the caller clears the old row after) and
    // says whether there was one to carry.
    carry(fromPath: string, toPath: string, fingerprint: string): boolean {
        const from = path.resolve(fromPath);
        const report = this.readyReport(from, fingerprint);
        if (!report) return false;
        this.writeCarried(from, path.resolve(toPath), fingerprint, report);
        return true;
    }

    // For a folder moved without the server (by hand or by a file manager): adopts the ready
    // checkpoint of a recording of the same folder name and the same playlist elsewhere, when
    // this path has none. Returns the path it came from.
    adoptMoved(recordingPath: string, fingerprint: string): string | null {
        const target = path.resolve(recordingPath);
        if (this.database.prepare("SELECT 1 FROM integrity_checkpoints WHERE recording_path = ?").get(target)) {
            return null;
        }
        const suffix = path.sep + path.basename(target);
        const rows = this.database.prepare(`
            SELECT recording_path FROM integrity_checkpoints
            WHERE substr(recording_path, -length(?)) = ? AND playlist_fingerprint = ?
            ORDER BY updated_at DESC
        `).all(suffix, suffix, fingerprint) as { recording_path: string }[];
        for (const { recording_path: from } of rows) {
            const report = this.readyReport(from, fingerprint);
            if (!report) continue;
            this.writeCarried(from, target, fingerprint, report);
            return from;
        }
        return null;
    }

    private readyReport(recordingPath: string, fingerprint: string): Record<string, unknown> | null {
        const report = this.read<Record<string, unknown>>(recordingPath, fingerprint);
        return report && report.version === 2 && report.status === "ready" ? report : null;
    }

    private writeCarried(from: string, to: string, fingerprint: string, report: Record<string, unknown>): void {
        const carried: Record<string, unknown> = { ...report, movedFrom: from };
        if (typeof report.playlistPath === "string") {
            carried.playlistPath = path.join(to, path.basename(report.playlistPath));
        }
        this.write(to, fingerprint, carried);
    }

    clear(recordingPath: string): void {
        this.database.prepare("DELETE FROM integrity_checkpoints WHERE recording_path = ?")
            .run(path.resolve(recordingPath));
    }

    // media_repairs may hold a destructive-repair journal. Nothing in this server
    // writes one; finalization reads any it finds and clears it.
    readRepair<T>(recordingPath: string): T | null {
        const row = this.database.prepare("SELECT plan_json FROM media_repairs WHERE recording_path = ?")
            .get(path.resolve(recordingPath)) as { plan_json: string } | undefined;
        if (!row) return null;
        try {
            return JSON.parse(row.plan_json) as T;
        } catch {
            return {} as T;
        }
    }

    clearRepair(recordingPath: string): void {
        this.database.prepare("DELETE FROM media_repairs WHERE recording_path = ?").run(path.resolve(recordingPath));
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

    // Compacts legacy v1 published fmp4 capture journals (which stored full playlists and
    // per-segment source hashes, ~500 KB - 1 MB each) into compact v2 published receipts
    // (~300 bytes) and removes stale checkpoints for paths that no longer exist on disk.
    compact(pathExists?: (recordingPath: string) => boolean, vacuum = false): { compactedJournals: number; prunedCheckpoints: number } {
        let compactedJournals = 0;
        let prunedCheckpoints = 0;
        const now = new Date().toISOString();
        this.database.exec("BEGIN IMMEDIATE");
        try {
            const updateMeta = this.database.prepare("UPDATE finalization_meta SET value = ?, updated_at = ? WHERE key = ?");
            const rows = this.database.prepare("SELECT key, value FROM finalization_meta WHERE key LIKE 'lossless-fmp4-capture-v1:%'").all() as Array<{ key: string; value: string }>;
            for (const row of rows) {
                try {
                    const parsed = JSON.parse(row.value) as Record<string, unknown>;
                    if (parsed.version === 1 && parsed.phase === "published" && typeof parsed.candidatePlaylist === "string") {
                        const compact = {
                            version: 2,
                            phase: "published",
                            candidatePlaylistSha: createHash("sha256").update(parsed.candidatePlaylist).digest("hex"),
                            outputs: parsed.outputs ?? [],
                            preservedNames: parsed.preservedNames ?? [],
                            splitNames: parsed.splitNames ?? [],
                            corrections: parsed.corrections ?? 0,
                            ...(Array.isArray(parsed.mapCorrections) && parsed.mapCorrections.length ? { mapCorrections: parsed.mapCorrections } : {}),
                        };
                        updateMeta.run(JSON.stringify(compact), now, row.key);
                        compactedJournals += 1;
                    }
                } catch {}
            }
            if (pathExists) {
                const del = this.database.prepare("DELETE FROM integrity_checkpoints WHERE recording_path = ?");
                const checkpoints = this.database.prepare("SELECT recording_path FROM integrity_checkpoints").all() as Array<{ recording_path: string }>;
                for (const { recording_path } of checkpoints) {
                    if (!pathExists(recording_path)) {
                        del.run(recording_path);
                        prunedCheckpoints += 1;
                    }
                }
            }
            this.database.exec("COMMIT");
        } catch (error) {
            this.database.exec("ROLLBACK");
            throw error;
        }
        if (vacuum) {
            this.database.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
        }
        return { compactedJournals, prunedCheckpoints };
    }

    close(): void {
        this.database.close();
    }
}
