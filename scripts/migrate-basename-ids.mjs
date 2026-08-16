#!/usr/bin/env node
// One-shot migration: hash IDs -> folder-name IDs, zombie schema cleanup.
import { DatabaseSync } from "node:sqlite";
import { existsSync, renameSync } from "node:fs";
import path from "node:path";

const dbPath = process.argv[2] ?? "/home/visar/.local/share/video-services/pipeline/pipeline.sqlite";
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = OFF");

const FK_TABLES = [
    "state_events", "artifacts", "descriptions", "remux_outputs",
    "recording_provenance", "upload_metadata", "upload_reservations",
    "upload_attempts", "upload_confirmations", "bandwidth_events",
    "remote_verifications", "xvideos_entries",
];

const recordings = db.prepare("SELECT id, source_path FROM recordings").all();
const idMap = new Map();
for (const row of recordings) {
    const newId = path.basename(row.source_path);
    if (newId !== row.id) idMap.set(row.id, newId);
}

const allIds = new Set(recordings.map((row) => row.id));
for (const [oldId, newId] of idMap) {
    if (allIds.has(newId)) {
        throw new Error(`ID collision: ${newId} already exists; resolve manually before migrating`);
    }
}

db.exec("BEGIN");
try {
    for (const [oldId, newId] of idMap) {
        for (const table of FK_TABLES) {
            db.prepare(`UPDATE ${table} SET recording_id = ? WHERE recording_id = ?`).run(newId, oldId);
        }
        db.prepare("UPDATE recordings SET id = ? WHERE id = ?").run(newId, oldId);
        for (const table of ["artifacts", "remux_outputs"]) {
            const row = db.prepare(`SELECT path FROM ${table} WHERE recording_id = ?`).get(newId);
            if (row) {
                const newPath = row.path.replace(oldId, newId);
                if (newPath !== row.path && existsSync(row.path)) {
                    renameSync(row.path, newPath);
                }
                db.prepare(`UPDATE ${table} SET path = ? WHERE recording_id = ?`).run(newPath, newId);
            }
        }
        console.log(`migrated ${oldId.slice(0, 12)} -> ${newId}`);
    }

    db.exec(`
        CREATE TABLE upload_metadata_new (
            recording_id TEXT PRIMARY KEY REFERENCES recordings(id),
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            tags_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        ) STRICT
    `);
    db.exec("INSERT INTO upload_metadata_new (recording_id, title, description, tags_json, created_at) SELECT recording_id, title, description, tags_json, created_at FROM upload_metadata");
    db.exec("DROP TABLE upload_metadata");
    db.exec("ALTER TABLE upload_metadata_new RENAME TO upload_metadata");
    db.exec(`
        CREATE TABLE upload_confirmations_new (
            attempt_id TEXT PRIMARY KEY REFERENCES upload_attempts(id),
            recording_id TEXT NOT NULL REFERENCES recordings(id),
            confirm_after TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('pending', 'found', 'absent')),
            checked_at TEXT
        ) STRICT
    `);
    db.exec("INSERT INTO upload_confirmations_new (attempt_id, recording_id, confirm_after, status, checked_at) SELECT attempt_id, recording_id, confirm_after, status, checked_at FROM upload_confirmations");
    db.exec("DROP TABLE upload_confirmations");
    db.exec("ALTER TABLE upload_confirmations_new RENAME TO upload_confirmations");
    db.exec("DROP TABLE streamer_models");
    db.exec(`
        CREATE TABLE remote_uploads (
            recording_id TEXT PRIMARY KEY REFERENCES recordings(id),
            attempt_id TEXT NOT NULL,
            remote_id TEXT NOT NULL,
            remote_url TEXT NOT NULL,
            verified_at TEXT NOT NULL
        ) STRICT
    `);
    db.exec(`
        INSERT INTO remote_uploads (recording_id, attempt_id, remote_id, remote_url, verified_at)
        SELECT recording_id, attempt_id, remote_id, remote_url, verified_at FROM remote_verifications
    `);
    db.exec("DROP TABLE remote_verifications");
    db.exec("DROP TABLE xvideos_entries");
    db.exec(`
        CREATE TABLE bandwidth_events_new (
            id INTEGER PRIMARY KEY,
            recording_id TEXT NOT NULL,
            attempt_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            calendar_month TEXT NOT NULL,
            transmitted_bytes INTEGER NOT NULL CHECK (transmitted_bytes >= 0),
            created_at TEXT NOT NULL
        ) STRICT
    `);
    db.exec("INSERT INTO bandwidth_events_new SELECT * FROM bandwidth_events");
    db.exec("DROP TABLE bandwidth_events");
    db.exec("ALTER TABLE bandwidth_events_new RENAME TO bandwidth_events");
    db.exec(`
        CREATE TABLE upload_attempts_new (
            id TEXT PRIMARY KEY,
            reservation_id TEXT REFERENCES upload_reservations(id),
            recording_id TEXT NOT NULL REFERENCES recordings(id),
            provider TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('started', 'failed', 'accepted', 'uncertain')),
            phase TEXT NOT NULL DEFAULT 'started' CHECK (phase IN ('started', 'file_uploading', 'file_uploaded', 'metadata_submitting')),
            progress_bytes INTEGER NOT NULL DEFAULT 0 CHECK (progress_bytes >= 0),
            transmitted_bytes INTEGER NOT NULL DEFAULT 0 CHECK (transmitted_bytes >= 0),
            remote_id TEXT,
            remote_url TEXT,
            error TEXT,
            started_at TEXT NOT NULL,
            completed_at TEXT
        ) STRICT
    `);
    db.exec(`
        INSERT INTO upload_attempts_new (
            id, reservation_id, recording_id, provider, status, phase,
            progress_bytes, transmitted_bytes, remote_id, remote_url, error, started_at, completed_at
        ) SELECT
            id, reservation_id, recording_id, provider, status, phase,
            COALESCE(progress_bytes, 0), COALESCE(transmitted_bytes, 0),
            remote_id, remote_url, error, started_at, completed_at
        FROM upload_attempts
    `);
    db.exec("DROP TABLE upload_attempts");
    db.exec("ALTER TABLE upload_attempts_new RENAME TO upload_attempts");
    db.exec("COMMIT");
    console.log("migration complete");
} catch (error) {
    db.exec("ROLLBACK");
    throw error;
} finally {
    db.close();
}
