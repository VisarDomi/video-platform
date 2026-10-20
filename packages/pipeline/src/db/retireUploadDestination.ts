import type { DatabaseSync } from "node:sqlite";

// Schema compatibility only. No adapter, credentials, inventory or receipt from
// the retired destination can authorize work or cleanup in the live pipeline.
export function retireUploadDestination(db: DatabaseSync, now = new Date()): void {
    const timestamp = now.toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS retired_destination_audit (
            destination TEXT PRIMARY KEY, retired_at TEXT NOT NULL, evidence_json TEXT NOT NULL
        ) STRICT`);
        // Early pasted imports used source-provider labels. A recorded canonical
        // surviving-provider URL is stronger evidence than that legacy label.
        db.exec(`UPDATE upload_attempts SET provider='porntrex'
            WHERE remote_url LIKE 'https://www.porntrex.com/%' AND provider IN ('tango','fc2','sc')`);
        const attempts = db.prepare(`SELECT * FROM upload_attempts WHERE provider <> 'porntrex'
            OR remote_url LIKE 'https://www.xvideos.com/%'`).all();
        db.exec(`CREATE TEMP TABLE retiring_attempts (id TEXT PRIMARY KEY);
            INSERT INTO retiring_attempts SELECT id FROM upload_attempts WHERE provider <> 'porntrex'
                OR remote_url LIKE 'https://www.xvideos.com/%';
            CREATE TEMP TABLE retiring_recordings (id TEXT PRIMARY KEY);
            INSERT OR IGNORE INTO retiring_recordings SELECT recording_id FROM upload_attempts WHERE id IN (SELECT id FROM retiring_attempts);
            INSERT OR IGNORE INTO retiring_recordings SELECT recording_id FROM short_parts WHERE destination_provider <> 'porntrex';
            INSERT OR IGNORE INTO retiring_recordings SELECT batch_id FROM short_parts WHERE destination_provider <> 'porntrex' AND batch_id IS NOT NULL`);
        const evidence: Record<string, unknown> = { attempts };
        for (const table of ["recordings", "artifacts", "remux_outputs", "descriptions", "upload_metadata", "production_artifact_queue", "manual_pieces"]) {
            const key = table === "recordings" ? "id" : "recording_id";
            evidence[table] = db.prepare(`SELECT * FROM ${table} WHERE ${key} IN (SELECT id FROM retiring_recordings)`).all();
        }
        evidence.confirmations = db.prepare("SELECT * FROM upload_confirmations WHERE attempt_id IN (SELECT id FROM retiring_attempts)").all();
        evidence.remote_uploads = db.prepare("SELECT * FROM remote_uploads WHERE attempt_id IN (SELECT id FROM retiring_attempts)").all();
        for (const table of ["provider_inventory", "provider_inventory_syncs", "provider_removals", "rejected_phrases"]) {
            evidence[table] = db.prepare(`SELECT * FROM ${table} WHERE provider <> 'porntrex'`).all();
        }
        if (attempts.length || (evidence.provider_inventory as unknown[]).length) {
            db.prepare("INSERT OR IGNORE INTO retired_destination_audit VALUES (?, ?, ?)")
                .run("retired-upload-provider", timestamp, JSON.stringify(evidence));
        }
        db.exec(`DELETE FROM upload_confirmations WHERE attempt_id IN (SELECT id FROM retiring_attempts);
            DELETE FROM remote_uploads WHERE attempt_id IN (SELECT id FROM retiring_attempts);
            DELETE FROM upload_attempts WHERE id IN (SELECT id FROM retiring_attempts);
            DELETE FROM upload_reservations WHERE provider <> 'porntrex';
            UPDATE bandwidth_events SET provider='retired' WHERE provider <> 'porntrex';
            DELETE FROM provider_inventory WHERE provider <> 'porntrex';
            DELETE FROM provider_inventory_syncs WHERE provider <> 'porntrex';
            DELETE FROM provider_removals WHERE provider <> 'porntrex';
            DELETE FROM rejected_phrases WHERE provider <> 'porntrex';
            UPDATE short_parts SET destination_provider='porntrex', verified=0 WHERE destination_provider <> 'porntrex';
            UPDATE short_parts SET verified=0 WHERE batch_id IN (SELECT id FROM retiring_recordings);
            UPDATE recordings SET state=replace(state,'xvideos_','upload_') WHERE state LIKE 'xvideos_%';
            UPDATE state_events SET from_state=replace(from_state,'xvideos_','upload_'), to_state=replace(to_state,'xvideos_','upload_');
            UPDATE recordings SET state='uploading' WHERE state='upload_uploading';
            UPDATE recordings SET state='uploaded' WHERE state='upload_uploaded';
            UPDATE state_events SET from_state=CASE from_state WHEN 'upload_uploading' THEN 'uploading' WHEN 'upload_uploaded' THEN 'uploaded' ELSE from_state END,
                to_state=CASE to_state WHEN 'upload_uploading' THEN 'uploading' WHEN 'upload_uploaded' THEN 'uploaded' ELSE to_state END;
            UPDATE campaign_control SET upload_provider='porntrex';`);
        // Preserve surviving-provider work and its exact verification receipts.
        // All other retired-destination recordings require a fresh conversion.
        const records = db.prepare(`SELECT id,state,duration_seconds FROM recordings WHERE id IN (SELECT id FROM retiring_recordings)
            AND NOT EXISTS (SELECT 1 FROM remote_uploads u WHERE u.recording_id=recordings.id)
            AND NOT EXISTS (SELECT 1 FROM upload_attempts a WHERE a.recording_id=recordings.id AND a.provider='porntrex' AND a.status <> 'failed')
            AND NOT EXISTS (SELECT 1 FROM provider_removals m WHERE m.recording_id=recordings.id AND m.provider='porntrex')`)
            .all() as unknown as Array<{ id: string; state: string; duration_seconds: number }>;
        for (const record of records) {
            for (const table of ["artifacts", "remux_outputs", "descriptions", "upload_metadata", "production_artifact_queue", "manual_pieces"]) {
                db.prepare(`DELETE FROM ${table} WHERE recording_id=?`).run(record.id);
            }
            const joined = db.prepare("SELECT 1 FROM short_parts WHERE recording_id=? AND batch_id IS NOT NULL").get(record.id);
            const state = joined ? "short_joined" : record.duration_seconds < 120 ? "short_waiting" : "server_ready";
            db.prepare("UPDATE recordings SET state=?,block_reason=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?")
                .run(state, timestamp, record.id);
            db.prepare("INSERT INTO state_events (recording_id,from_state,to_state,reason,created_at) VALUES (?,?,?,?,?)")
                .run(record.id, record.state, state, "previous upload destination retired; Porntrex backup required", timestamp);
        }
        db.exec(`UPDATE recordings SET state='short_joined' WHERE state IN ('cleanup_eligible','upload_verified')
            AND EXISTS (SELECT 1 FROM short_parts s WHERE s.recording_id=recordings.id AND s.verified=0 AND s.batch_id IS NOT NULL)
            AND NOT EXISTS (SELECT 1 FROM remote_uploads u WHERE u.recording_id=recordings.id);
            UPDATE recordings SET state='blocked',block_reason='Porntrex removed this recording; it remains excluded from re-upload'
            WHERE id IN (SELECT id FROM retiring_recordings) AND EXISTS (
                SELECT 1 FROM provider_removals m WHERE m.recording_id=recordings.id AND m.provider='porntrex')
                AND NOT EXISTS (SELECT 1 FROM remote_uploads u WHERE u.recording_id=recordings.id)`);
        // These two tables had destination-specific CHECK constraints in v13.
        for (const table of ["campaign_control", "provider_removals"]) {
            const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string };
            if (!row.sql.includes("'xvideos'")) continue;
            const replacement = row.sql.replace(`CREATE TABLE ${table}`, `CREATE TABLE ${table}_single_destination`)
                .replaceAll("DEFAULT 'xvideos'", "DEFAULT 'porntrex'")
                .replaceAll("IN ('xvideos', 'porntrex')", "= 'porntrex'");
            db.exec(replacement);
            db.exec(`INSERT INTO ${table}_single_destination SELECT * FROM ${table}; DROP TABLE ${table};
                ALTER TABLE ${table}_single_destination RENAME TO ${table}`);
        }
        db.exec("DROP TABLE retiring_attempts; DROP TABLE retiring_recordings; UPDATE schema_version SET version=14; COMMIT");
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}
