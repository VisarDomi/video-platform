import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { assertTransition, type PipelineState } from "../domain/states.js";
import type { ArtifactRecord, Recording, RecordingInput } from "../domain/types.js";

const SCHEMA_VERSION = 1;
const DEFAULT_MONTHLY_UPLOAD_LIMIT_BYTES = 600_000_000_000;

interface RecordingRow {
    id: string;
    provider: string;
    source_kind: "downloader" | "edited";
    source_path: string;
    playlist_path: string;
    source_fingerprint: string;
    duration_seconds: number;
    state: PipelineState;
    block_reason: string | null;
    lease_owner: string | null;
    lease_expires_at: string | null;
    attempt_count: number;
    created_at: string;
    updated_at: string;
}

interface ArtifactRow {
    recording_id: string;
    path: string;
    size_bytes: number;
    sha256: string;
    validated_at: string;
}

interface UsageRow { spent: number; reserved: number }

function recordingId(input: RecordingInput): string {
    return createHash("sha256")
        .update(`${input.provider}\0${input.sourceKind}\0${path.resolve(input.sourcePath)}`)
        .digest("hex");
}

function mapRecording(row: RecordingRow): Recording {
    return {
        id: row.id,
        provider: row.provider,
        sourceKind: row.source_kind,
        sourcePath: row.source_path,
        playlistPath: row.playlist_path,
        sourceFingerprint: row.source_fingerprint,
        durationSeconds: row.duration_seconds,
        state: row.state,
        blockReason: row.block_reason,
        leaseOwner: row.lease_owner,
        leaseExpiresAt: row.lease_expires_at,
        attemptCount: row.attempt_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function mapArtifact(row: ArtifactRow): ArtifactRecord {
    return {
        recordingId: row.recording_id,
        path: row.path,
        sizeBytes: row.size_bytes,
        sha256: row.sha256,
        validatedAt: row.validated_at,
    };
}

export function calendarMonth(date: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
    }).formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    if (!year || !month) throw new Error(`Could not derive calendar month in ${timeZone}`);
    return `${year}-${month}`;
}

export class PipelineDatabase {
    private readonly database: DatabaseSync;

    constructor(databasePath: string) {
        if (databasePath !== ":memory:") mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
        this.database = new DatabaseSync(databasePath);
        this.database.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = FULL;
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER NOT NULL
            ) STRICT;
            INSERT INTO schema_version (version)
            SELECT ${SCHEMA_VERSION}
            WHERE NOT EXISTS (SELECT 1 FROM schema_version);
            CREATE TABLE IF NOT EXISTS recordings (
                id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                source_kind TEXT NOT NULL CHECK (source_kind IN ('downloader', 'edited')),
                source_path TEXT NOT NULL UNIQUE,
                playlist_path TEXT NOT NULL,
                source_fingerprint TEXT NOT NULL,
                duration_seconds REAL NOT NULL CHECK (duration_seconds > 0),
                state TEXT NOT NULL,
                block_reason TEXT,
                lease_owner TEXT,
                lease_expires_at TEXT,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            ) STRICT;
            CREATE INDEX IF NOT EXISTS recordings_state_idx ON recordings (state, created_at);
            CREATE TABLE IF NOT EXISTS state_events (
                id INTEGER PRIMARY KEY,
                recording_id TEXT NOT NULL REFERENCES recordings(id),
                from_state TEXT,
                to_state TEXT NOT NULL,
                reason TEXT,
                created_at TEXT NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS artifacts (
                recording_id TEXT PRIMARY KEY REFERENCES recordings(id),
                path TEXT NOT NULL UNIQUE,
                size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
                sha256 TEXT NOT NULL,
                validated_at TEXT NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS remux_outputs (
                recording_id TEXT PRIMARY KEY REFERENCES recordings(id),
                path TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS descriptions (
                recording_id TEXT PRIMARY KEY REFERENCES recordings(id),
                artifact_sha256 TEXT NOT NULL,
                prompt_version TEXT NOT NULL,
                fps REAL NOT NULL CHECK (fps > 0),
                output_json TEXT NOT NULL,
                evidence_path TEXT NOT NULL,
                created_at TEXT NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS upload_reservations (
                id TEXT PRIMARY KEY,
                recording_id TEXT NOT NULL REFERENCES recordings(id),
                provider TEXT NOT NULL,
                calendar_month TEXT NOT NULL,
                reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes > 0),
                status TEXT NOT NULL CHECK (status IN ('reserved', 'consumed', 'released')),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            ) STRICT;
            CREATE UNIQUE INDEX IF NOT EXISTS one_active_reservation_idx
                ON upload_reservations (recording_id) WHERE status = 'reserved';
            CREATE TABLE IF NOT EXISTS upload_attempts (
                id TEXT PRIMARY KEY,
                reservation_id TEXT NOT NULL REFERENCES upload_reservations(id),
                recording_id TEXT NOT NULL REFERENCES recordings(id),
                provider TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('started', 'failed', 'accepted', 'uncertain')),
                transmitted_bytes INTEGER NOT NULL DEFAULT 0 CHECK (transmitted_bytes >= 0),
                remote_id TEXT,
                remote_url TEXT,
                error TEXT,
                started_at TEXT NOT NULL,
                completed_at TEXT
            ) STRICT;
            CREATE TABLE IF NOT EXISTS bandwidth_events (
                id INTEGER PRIMARY KEY,
                recording_id TEXT NOT NULL REFERENCES recordings(id),
                attempt_id TEXT NOT NULL REFERENCES upload_attempts(id),
                provider TEXT NOT NULL,
                calendar_month TEXT NOT NULL,
                transmitted_bytes INTEGER NOT NULL CHECK (transmitted_bytes >= 0),
                created_at TEXT NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS remote_verifications (
                recording_id TEXT PRIMARY KEY REFERENCES recordings(id),
                attempt_id TEXT NOT NULL REFERENCES upload_attempts(id),
                remote_id TEXT NOT NULL,
                remote_url TEXT NOT NULL,
                playback_verified INTEGER NOT NULL CHECK (playback_verified = 1),
                verified_at TEXT NOT NULL
            ) STRICT;
        `);
        const version = this.database.prepare("SELECT version FROM schema_version").get() as { version: number };
        if (version.version !== SCHEMA_VERSION) {
            throw new Error(`Unsupported pipeline schema version ${version.version}`);
        }
    }

    close(): void { this.database.close(); }

    integrityCheck(): string {
        const row = this.database.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
        return row.integrity_check;
    }

    discover(input: RecordingInput, now = new Date()): Recording {
        if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0) {
            throw new Error("durationSeconds must be positive");
        }
        const normalized: RecordingInput = {
            ...input,
            sourcePath: path.resolve(input.sourcePath),
            playlistPath: path.resolve(input.playlistPath),
        };
        const id = recordingId(normalized);
        const existing = this.get(id);
        const timestamp = now.toISOString();
        if (!existing) {
            this.transaction(() => {
                this.database.prepare(`
                    INSERT INTO recordings (
                        id, provider, source_kind, source_path, playlist_path,
                        source_fingerprint, duration_seconds, state, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?)
                `).run(
                    id, normalized.provider, normalized.sourceKind, normalized.sourcePath,
                    normalized.playlistPath, normalized.sourceFingerprint,
                    normalized.durationSeconds, timestamp, timestamp,
                );
                this.insertEvent(id, null, "discovered", "eligible finalized recording discovered", timestamp);
            });
        } else if (existing.sourceFingerprint !== normalized.sourceFingerprint) {
            this.transaction(() => {
                this.database.prepare(`
                    UPDATE recordings SET state = 'blocked', block_reason = ?, lease_owner = NULL,
                        lease_expires_at = NULL, source_fingerprint = ?, duration_seconds = ?, updated_at = ?
                    WHERE id = ?
                `).run("source changed after discovery; manual review required", normalized.sourceFingerprint,
                    normalized.durationSeconds, timestamp, id);
                this.insertEvent(id, existing.state, "blocked", "source fingerprint changed", timestamp);
            });
        }
        const result = this.get(id);
        if (!result) throw new Error(`Failed to persist recording ${id}`);
        return result;
    }

    get(id: string): Recording | null {
        const row = this.database.prepare("SELECT * FROM recordings WHERE id = ?").get(id) as RecordingRow | undefined;
        return row ? mapRecording(row) : null;
    }

    list(state?: PipelineState): Recording[] {
        const statement = state
            ? this.database.prepare("SELECT * FROM recordings WHERE state = ? ORDER BY created_at, id")
            : this.database.prepare("SELECT * FROM recordings ORDER BY created_at, id");
        const rows = (state ? statement.all(state) : statement.all()) as unknown as RecordingRow[];
        return rows.map(mapRecording);
    }

    transition(id: string, expected: PipelineState, next: PipelineState, reason: string | null = null, now = new Date()): Recording {
        assertTransition(expected, next);
        const timestamp = now.toISOString();
        this.transaction(() => {
            const result = this.database.prepare(`
                UPDATE recordings SET state = ?, block_reason = ?, updated_at = ?
                WHERE id = ? AND state = ?
            `).run(next, next === "blocked" || next === "failed" ? reason : null, timestamp, id, expected);
            if (result.changes !== 1) throw new Error(`Recording ${id} is not in expected state ${expected}`);
            this.insertEvent(id, expected, next, reason, timestamp);
        });
        const recording = this.get(id);
        if (!recording) throw new Error(`Recording ${id} disappeared`);
        return recording;
    }

    saveIntegrityReady(id: string, evidence: {
        sourceFingerprint: string;
        durationSeconds: number;
    }, now = new Date()): Recording {
        if (!/^[a-f0-9]{64}$/.test(evidence.sourceFingerprint)) throw new Error("Invalid integrity fingerprint");
        if (!Number.isFinite(evidence.durationSeconds) || evidence.durationSeconds <= 0) {
            throw new Error("Invalid integrity duration");
        }
        const timestamp = now.toISOString();
        this.transaction(() => {
            const result = this.database.prepare(`
                UPDATE recordings SET state = 'integrity_ready', source_fingerprint = ?,
                    duration_seconds = ?, block_reason = NULL, updated_at = ?
                WHERE id = ? AND state = 'playlist_repaired'
            `).run(evidence.sourceFingerprint, evidence.durationSeconds, timestamp, id);
            if (result.changes !== 1) throw new Error(`Recording ${id} is not in expected state playlist_repaired`);
            this.insertEvent(id, "playlist_repaired", "integrity_ready", "ready integrity evidence matched repaired source", timestamp);
        });
        return this.requireRecording(id);
    }

    claimNext(states: readonly PipelineState[], owner: string, leaseMilliseconds: number, now = new Date()): Recording | null {
        if (states.length === 0 || leaseMilliseconds <= 0) throw new Error("claimNext needs states and a positive lease");
        const timestamp = now.toISOString();
        const expiry = new Date(now.getTime() + leaseMilliseconds).toISOString();
        const placeholders = states.map(() => "?").join(", ");
        let claimedId: string | null = null;
        this.transaction(() => {
            const row = this.database.prepare(`
                SELECT id FROM recordings
                WHERE state IN (${placeholders})
                  AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
                ORDER BY created_at, id LIMIT 1
            `).get(...states as SQLInputValue[], timestamp) as { id: string } | undefined;
            if (!row) return;
            const result = this.database.prepare(`
                UPDATE recordings SET lease_owner = ?, lease_expires_at = ?,
                    attempt_count = attempt_count + 1, updated_at = ?
                WHERE id = ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
            `).run(owner, expiry, timestamp, row.id, timestamp);
            if (result.changes === 1) claimedId = row.id;
        });
        return claimedId ? this.get(claimedId) : null;
    }

    releaseLease(id: string, owner: string, now = new Date()): void {
        const result = this.database.prepare(`
            UPDATE recordings SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
            WHERE id = ? AND lease_owner = ?
        `).run(now.toISOString(), id, owner);
        if (result.changes !== 1) throw new Error(`Lease for ${id} is not owned by ${owner}`);
    }

    retryFailed(id: string, now = new Date()): Recording {
        const timestamp = now.toISOString();
        this.transaction(() => {
            const lastFailure = this.database.prepare(`
                SELECT from_state FROM state_events
                WHERE recording_id = ? AND to_state = 'failed'
                ORDER BY id DESC LIMIT 1
            `).get(id) as { from_state: PipelineState | null } | undefined;
            const retryState = lastFailure?.from_state;
            if (!retryState || ![
                "discovered", "playlist_repaired", "integrity_ready", "remuxed", "artifact_valid", "described",
            ].includes(retryState)) {
                throw new Error(`Recording ${id} has no retryable failure state`);
            }
            this.updateStateInTransaction(id, "failed", retryState, "manual retry requested", timestamp);
        });
        return this.requireRecording(id);
    }

    saveArtifact(id: string, artifact: Omit<ArtifactRecord, "recordingId">, now = new Date()): Recording {
        const recording = this.get(id);
        if (!recording || recording.state !== "remuxed") throw new Error(`Recording ${id} is not remuxed`);
        if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0 || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
            throw new Error("Artifact requires a positive integer size and lowercase SHA-256");
        }
        const timestamp = now.toISOString();
        this.transaction(() => {
            this.database.prepare(`
                INSERT INTO artifacts (recording_id, path, size_bytes, sha256, validated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(recording_id) DO UPDATE SET path = excluded.path,
                    size_bytes = excluded.size_bytes, sha256 = excluded.sha256,
                    validated_at = excluded.validated_at
            `).run(id, path.resolve(artifact.path), artifact.sizeBytes, artifact.sha256, artifact.validatedAt);
            this.updateStateInTransaction(id, "remuxed", "artifact_valid", "artifact hash and validation persisted", timestamp);
        });
        return this.requireRecording(id);
    }

    getArtifact(id: string): ArtifactRecord | null {
        const row = this.database.prepare("SELECT * FROM artifacts WHERE recording_id = ?").get(id) as ArtifactRow | undefined;
        return row ? mapArtifact(row) : null;
    }

    saveRemuxOutput(id: string, outputPath: string, now = new Date()): Recording {
        const timestamp = now.toISOString();
        this.transaction(() => {
            this.database.prepare(`
                INSERT INTO remux_outputs (recording_id, path, created_at)
                VALUES (?, ?, ?)
                ON CONFLICT(recording_id) DO UPDATE SET path = excluded.path, created_at = excluded.created_at
            `).run(id, path.resolve(outputPath), timestamp);
            this.updateStateInTransaction(id, "integrity_ready", "remuxed", "stream-copy artifact published", timestamp);
        });
        return this.requireRecording(id);
    }

    getRemuxOutput(id: string): string | null {
        const row = this.database.prepare("SELECT path FROM remux_outputs WHERE recording_id = ?").get(id) as {
            path: string;
        } | undefined;
        return row?.path ?? null;
    }

    saveDescription(id: string, description: {
        artifactSha256: string;
        promptVersion: string;
        fps: number;
        output: unknown;
        evidencePath: string;
    }, now = new Date()): Recording {
        const recording = this.requireRecording(id);
        const artifact = this.getArtifact(id);
        if (recording.state !== "artifact_valid" || !artifact) throw new Error(`Recording ${id} has no valid artifact`);
        if (artifact.sha256 !== description.artifactSha256) throw new Error("Description does not match the current artifact hash");
        const timestamp = now.toISOString();
        this.transaction(() => {
            this.database.prepare(`
                INSERT INTO descriptions (
                    recording_id, artifact_sha256, prompt_version, fps,
                    output_json, evidence_path, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(recording_id) DO UPDATE SET
                    artifact_sha256 = excluded.artifact_sha256,
                    prompt_version = excluded.prompt_version, fps = excluded.fps,
                    output_json = excluded.output_json, evidence_path = excluded.evidence_path,
                    created_at = excluded.created_at
            `).run(id, description.artifactSha256, description.promptVersion, description.fps,
                JSON.stringify(description.output), path.resolve(description.evidencePath), timestamp);
            this.updateStateInTransaction(id, "artifact_valid", "described", "description persisted for artifact hash", timestamp);
        });
        return this.requireRecording(id);
    }

    uploadUsage(month: string): UsageRow {
        const spent = this.database.prepare(`
            SELECT COALESCE(SUM(transmitted_bytes), 0) AS spent
            FROM bandwidth_events WHERE calendar_month = ?
        `).get(month) as { spent: number };
        const reserved = this.database.prepare(`
            SELECT COALESCE(SUM(reserved_bytes), 0) AS reserved
            FROM upload_reservations WHERE calendar_month = ? AND status = 'reserved'
        `).get(month) as { reserved: number };
        return { spent: spent.spent, reserved: reserved.reserved };
    }

    canReserve(bytes: number, now = new Date(), timeZone = "Europe/Tirane", limit = DEFAULT_MONTHLY_UPLOAD_LIMIT_BYTES): boolean {
        const usage = this.uploadUsage(calendarMonth(now, timeZone));
        return Number.isSafeInteger(bytes) && bytes > 0 && usage.spent + usage.reserved + bytes <= limit;
    }

    reserveUpload(id: string, bytes: number, now = new Date(), timeZone = "Europe/Tirane", limit = DEFAULT_MONTHLY_UPLOAD_LIMIT_BYTES): string {
        if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("Upload reservation bytes must be a positive integer");
        const month = calendarMonth(now, timeZone);
        const timestamp = now.toISOString();
        const reservationId = randomUUID();
        this.transaction(() => {
            const recording = this.requireRecording(id);
            if (recording.state !== "described") throw new Error(`Recording ${id} is not described`);
            const usage = this.uploadUsage(month);
            if (usage.spent + usage.reserved + bytes > limit) throw new Error(`Monthly upload limit exceeded for ${month}`);
            this.database.prepare(`
                INSERT INTO upload_reservations (
                    id, recording_id, provider, calendar_month, reserved_bytes,
                    status, created_at, updated_at
                ) VALUES (?, ?, 'xvideos', ?, ?, 'reserved', ?, ?)
            `).run(reservationId, id, month, bytes, timestamp, timestamp);
            this.updateStateInTransaction(id, "described", "xvideos_admitted", "monthly bytes reserved", timestamp);
        });
        return reservationId;
    }

    beginUpload(id: string, reservationId: string, now = new Date()): string {
        const attemptId = randomUUID();
        const timestamp = now.toISOString();
        this.transaction(() => {
            const reservation = this.database.prepare(`
                SELECT id FROM upload_reservations
                WHERE id = ? AND recording_id = ? AND status = 'reserved'
            `).get(reservationId, id);
            if (!reservation) throw new Error(`No active reservation ${reservationId} for ${id}`);
            this.database.prepare(`
                INSERT INTO upload_attempts (
                    id, reservation_id, recording_id, provider, status, started_at
                ) VALUES (?, ?, ?, 'xvideos', 'started', ?)
            `).run(attemptId, reservationId, id, timestamp);
            this.updateStateInTransaction(id, "xvideos_admitted", "xvideos_uploading", "upload attempt started", timestamp);
        });
        return attemptId;
    }

    finishUploadAttempt(attemptId: string, outcome: {
        status: "failed" | "accepted" | "uncertain";
        transmittedBytes: number;
        remoteId?: string;
        remoteUrl?: string;
        error?: string;
    }, now = new Date()): Recording {
        if (!Number.isSafeInteger(outcome.transmittedBytes) || outcome.transmittedBytes < 0) {
            throw new Error("transmittedBytes must be a nonnegative integer");
        }
        const timestamp = now.toISOString();
        let recordingId = "";
        this.transaction(() => {
            const attempt = this.database.prepare(`
                SELECT a.recording_id, a.reservation_id, r.reserved_bytes, r.calendar_month
                FROM upload_attempts a JOIN upload_reservations r ON r.id = a.reservation_id
                WHERE a.id = ? AND a.status = 'started'
            `).get(attemptId) as {
                recording_id: string;
                reservation_id: string;
                reserved_bytes: number;
                calendar_month: string;
            } | undefined;
            if (!attempt) throw new Error(`Upload attempt ${attemptId} is not active`);
            if (outcome.transmittedBytes > attempt.reserved_bytes) {
                throw new Error("Transmitted bytes exceed the upload reservation");
            }
            if (outcome.status === "accepted" && (!outcome.remoteId || !outcome.remoteUrl)) {
                throw new Error("Accepted upload requires remoteId and remoteUrl");
            }
            recordingId = attempt.recording_id;
            this.database.prepare(`
                UPDATE upload_attempts SET status = ?, transmitted_bytes = ?, remote_id = ?,
                    remote_url = ?, error = ?, completed_at = ? WHERE id = ?
            `).run(outcome.status, outcome.transmittedBytes, outcome.remoteId ?? null,
                outcome.remoteUrl ?? null, outcome.error ?? null, timestamp, attemptId);
            this.database.prepare(`
                INSERT INTO bandwidth_events (
                    recording_id, attempt_id, provider, calendar_month,
                    transmitted_bytes, created_at
                ) VALUES (?, ?, 'xvideos', ?, ?, ?)
            `).run(recordingId, attemptId, attempt.calendar_month, outcome.transmittedBytes, timestamp);
            this.database.prepare(`
                UPDATE upload_reservations SET status = ?, updated_at = ? WHERE id = ?
            `).run(outcome.status === "accepted" ? "consumed" : "released", timestamp, attempt.reservation_id);
            const next: PipelineState = outcome.status === "accepted"
                ? "xvideos_uploaded"
                : outcome.status === "uncertain" ? "xvideos_uncertain" : "described";
            this.updateStateInTransaction(recordingId, "xvideos_uploading", next,
                outcome.error ?? `upload attempt ${outcome.status}`, timestamp);
        });
        return this.requireRecording(recordingId);
    }

    reconcileUncertain(attemptId: string, remoteId: string, remoteUrl: string, now = new Date()): Recording {
        if (!remoteId || !remoteUrl) throw new Error("Reconciliation requires remote identity");
        const timestamp = now.toISOString();
        let recordingId = "";
        this.transaction(() => {
            const attempt = this.database.prepare(`
                SELECT recording_id, reservation_id FROM upload_attempts WHERE id = ? AND status = 'uncertain'
            `).get(attemptId) as { recording_id: string; reservation_id: string } | undefined;
            if (!attempt) throw new Error(`Upload attempt ${attemptId} is not uncertain`);
            recordingId = attempt.recording_id;
            this.database.prepare(`
                UPDATE upload_attempts SET status = 'accepted', remote_id = ?, remote_url = ?, completed_at = ?
                WHERE id = ?
            `).run(remoteId, remoteUrl, timestamp, attemptId);
            this.database.prepare(`
                UPDATE upload_reservations SET status = 'consumed', updated_at = ? WHERE id = ?
            `).run(timestamp, attempt.reservation_id);
            this.updateStateInTransaction(recordingId, "xvideos_uncertain", "xvideos_uploaded",
                "manual reconciliation found accepted remote upload", timestamp);
        });
        return this.requireRecording(recordingId);
    }

    markRemoteVerified(id: string, remoteId: string, remoteUrl: string, now = new Date()): Recording {
        const timestamp = now.toISOString();
        this.transaction(() => {
            const attempt = this.database.prepare(`
                SELECT id FROM upload_attempts
                WHERE recording_id = ? AND status = 'accepted' AND remote_id = ? AND remote_url = ?
                ORDER BY completed_at DESC LIMIT 1
            `).get(id, remoteId, remoteUrl) as { id: string } | undefined;
            if (!attempt) throw new Error("Verification does not match an accepted upload attempt");
            this.database.prepare(`
                INSERT INTO remote_verifications (
                    recording_id, attempt_id, remote_id, remote_url, playback_verified, verified_at
                ) VALUES (?, ?, ?, ?, 1, ?)
            `).run(id, attempt.id, remoteId, remoteUrl, timestamp);
            this.updateStateInTransaction(id, "xvideos_uploaded", "xvideos_verified",
                "remote processing and playback verified", timestamp);
        });
        return this.requireRecording(id);
    }

    private requireRecording(id: string): Recording {
        const recording = this.get(id);
        if (!recording) throw new Error(`Unknown recording ${id}`);
        return recording;
    }

    private insertEvent(id: string, from: PipelineState | null, to: PipelineState, reason: string | null, timestamp: string): void {
        this.database.prepare(`
            INSERT INTO state_events (recording_id, from_state, to_state, reason, created_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(id, from, to, reason, timestamp);
    }

    private updateStateInTransaction(id: string, expected: PipelineState, next: PipelineState, reason: string, timestamp: string): void {
        assertTransition(expected, next);
        const result = this.database.prepare(`
            UPDATE recordings SET state = ?, block_reason = NULL, updated_at = ?
            WHERE id = ? AND state = ?
        `).run(next, timestamp, id, expected);
        if (result.changes !== 1) throw new Error(`Recording ${id} is not in expected state ${expected}`);
        this.insertEvent(id, expected, next, reason, timestamp);
    }

    private transaction<T>(operation: () => T): T {
        this.database.exec("BEGIN IMMEDIATE");
        try {
            const result = operation();
            this.database.exec("COMMIT");
            return result;
        } catch (error) {
            this.database.exec("ROLLBACK");
            throw error;
        }
    }
}
