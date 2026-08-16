import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { assertTransition, type PipelineState } from "../domain/states.js";
import type {
    ArtifactRecord,
    CampaignControl,
    CampaignProviderFilter,
    DescriptionRecord,
    Recording,
    RecordingInput,
    RecordingProvenance,
    SourceKind,
    StreamerModelRecord,
    UploadConfirmation,
    UploadMetadataRecord,
} from "../domain/types.js";

const SCHEMA_VERSION = 4;
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

interface ProvenanceRow {
    recording_id: string;
    observed_identifier: string;
    resolution_status: RecordingProvenance["status"];
    streamer_id: string | null;
    alias: string | null;
    streamer_url: string | null;
    alias_url: string | null;
    reason: string | null;
    updated_at: string;
}

interface DescriptionRow {
    recording_id: string;
    artifact_sha256: string;
    prompt_version: string;
    fps: number;
    output_json: string;
    evidence_path: string;
    created_at: string;
}

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
                phase TEXT NOT NULL DEFAULT 'started' CHECK (phase IN ('started', 'file_uploading', 'file_uploaded', 'metadata_submitting')),
                progress_bytes INTEGER NOT NULL DEFAULT 0 CHECK (progress_bytes >= 0),
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
            CREATE TABLE IF NOT EXISTS recording_provenance (
                recording_id TEXT PRIMARY KEY REFERENCES recordings(id),
                observed_identifier TEXT NOT NULL,
                resolution_status TEXT NOT NULL CHECK (resolution_status IN ('resolved', 'review_required', 'manual')),
                streamer_id TEXT,
                alias TEXT,
                streamer_url TEXT,
                alias_url TEXT,
                reason TEXT,
                updated_at TEXT NOT NULL,
                CHECK (
                    resolution_status = 'review_required'
                    OR (streamer_id IS NOT NULL AND alias IS NOT NULL AND streamer_url IS NOT NULL)
                )
            ) STRICT;
            CREATE INDEX IF NOT EXISTS recording_provenance_status_idx
                ON recording_provenance (resolution_status, updated_at);
            CREATE TABLE IF NOT EXISTS provenance_overrides (
                provider TEXT NOT NULL,
                observed_identifier TEXT NOT NULL,
                streamer_id TEXT NOT NULL,
                alias TEXT NOT NULL,
                streamer_url TEXT NOT NULL,
                alias_url TEXT,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (provider, observed_identifier)
            ) STRICT;
            CREATE TABLE IF NOT EXISTS upload_metadata (
                recording_id TEXT PRIMARY KEY REFERENCES recordings(id),
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                tags_json TEXT NOT NULL,
                match_key TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS streamer_models (
                provider TEXT NOT NULL,
                streamer_id TEXT NOT NULL,
                stage_name TEXT NOT NULL,
                gender TEXT NOT NULL,
                how_known TEXT NOT NULL,
                profile_picture TEXT NOT NULL,
                xvideos_model_id TEXT,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (provider, streamer_id)
            ) STRICT;
            CREATE TABLE IF NOT EXISTS upload_confirmations (
                attempt_id TEXT PRIMARY KEY REFERENCES upload_attempts(id),
                recording_id TEXT NOT NULL REFERENCES recordings(id),
                match_key TEXT NOT NULL,
                confirm_after TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('pending', 'found', 'absent')),
                checked_at TEXT
            ) STRICT;
            CREATE INDEX IF NOT EXISTS upload_confirmations_due_idx
                ON upload_confirmations (status, confirm_after);
            CREATE TABLE IF NOT EXISTS xvideos_entries (
                recording_id TEXT PRIMARY KEY REFERENCES recordings(id),
                attempt_id TEXT NOT NULL REFERENCES upload_attempts(id),
                remote_id TEXT NOT NULL,
                remote_url TEXT NOT NULL,
                moderation_status TEXT,
                observed_at TEXT NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS campaign_control (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                state TEXT NOT NULL CHECK (state IN ('paused', 'running')),
                provider_filter TEXT NOT NULL CHECK (provider_filter IN ('all', 'tango', 'fc2', 'sc')),
                ordering TEXT NOT NULL CHECK (ordering = 'oldest'),
                monthly_upload_limit_bytes INTEGER NOT NULL CHECK (monthly_upload_limit_bytes > 0),
                updated_at TEXT NOT NULL
            ) STRICT;
            INSERT OR IGNORE INTO campaign_control (
                id, state, provider_filter, ordering, monthly_upload_limit_bytes, updated_at
            ) VALUES (1, 'paused', 'all', 'oldest', ${DEFAULT_MONTHLY_UPLOAD_LIMIT_BYTES}, '1970-01-01T00:00:00.000Z');
        `);
        const attemptColumns = this.database.prepare("PRAGMA table_info(upload_attempts)").all() as unknown as Array<{ name: string }>;
        if (!attemptColumns.some((column) => column.name === "phase")) {
            this.database.exec("ALTER TABLE upload_attempts ADD COLUMN phase TEXT NOT NULL DEFAULT 'started'");
        }
        if (!attemptColumns.some((column) => column.name === "progress_bytes")) {
            this.database.exec("ALTER TABLE upload_attempts ADD COLUMN progress_bytes INTEGER NOT NULL DEFAULT 0");
        }
        const version = this.database.prepare("SELECT version FROM schema_version").get() as { version: number };
        if (version.version === 2 || version.version === 3) {
            this.database.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
        } else if (version.version !== SCHEMA_VERSION) {
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
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'server_ready', ?, ?)
                `).run(
                    id, normalized.provider, normalized.sourceKind, normalized.sourcePath,
                    normalized.playlistPath, normalized.sourceFingerprint,
                    normalized.durationSeconds, timestamp, timestamp,
                );
                this.insertEvent(id, null, "server_ready", "server-published finalized recording discovered", timestamp);
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

    getBySourcePath(sourcePath: string): Recording | null {
        const row = this.database.prepare("SELECT * FROM recordings WHERE source_path = ?")
            .get(path.resolve(sourcePath)) as RecordingRow | undefined;
        return row ? mapRecording(row) : null;
    }

    getCampaignControl(): CampaignControl {
        const row = this.database.prepare("SELECT * FROM campaign_control WHERE id = 1").get() as {
            state: CampaignControl["state"];
            provider_filter: CampaignProviderFilter;
            ordering: "oldest";
            monthly_upload_limit_bytes: number;
            updated_at: string;
        } | undefined;
        if (!row) throw new Error("Campaign control row is missing");
        return {
            state: row.state,
            providerFilter: row.provider_filter,
            ordering: row.ordering,
            monthlyUploadLimitBytes: row.monthly_upload_limit_bytes,
            updatedAt: row.updated_at,
        };
    }

    configureCampaign(
        providerFilter: CampaignProviderFilter,
        monthlyUploadLimitBytes: number,
        now = new Date(),
    ): CampaignControl {
        if (!["all", "tango", "fc2", "sc"].includes(providerFilter)) {
            throw new Error("Campaign provider must be all, tango, fc2, or sc");
        }
        if (!Number.isSafeInteger(monthlyUploadLimitBytes) || monthlyUploadLimitBytes <= 0) {
            throw new Error("Campaign monthly upload limit must be a positive integer");
        }
        this.database.prepare(`
            UPDATE campaign_control SET provider_filter = ?, ordering = 'oldest',
                monthly_upload_limit_bytes = ?, updated_at = ? WHERE id = 1
        `).run(providerFilter, monthlyUploadLimitBytes, now.toISOString());
        return this.getCampaignControl();
    }

    setCampaignState(state: CampaignControl["state"], now = new Date()): CampaignControl {
        if (state !== "paused" && state !== "running") throw new Error("Campaign state must be paused or running");
        this.database.prepare("UPDATE campaign_control SET state = ?, updated_at = ? WHERE id = 1")
            .run(state, now.toISOString());
        return this.getCampaignControl();
    }

    saveProvenance(
        id: string,
        provenance: Omit<RecordingProvenance, "recordingId">,
    ): RecordingProvenance {
        this.requireRecording(id);
        const existing = this.getProvenance(id);
        if (existing?.status === "manual" && provenance.status !== "manual") return existing;
        this.validateProvenance(provenance);
        this.database.prepare(`
            INSERT INTO recording_provenance (
                recording_id, observed_identifier, resolution_status, streamer_id,
                alias, streamer_url, alias_url, reason, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(recording_id) DO UPDATE SET
                observed_identifier = excluded.observed_identifier,
                resolution_status = excluded.resolution_status,
                streamer_id = excluded.streamer_id,
                alias = excluded.alias,
                streamer_url = excluded.streamer_url,
                alias_url = excluded.alias_url,
                reason = excluded.reason,
                updated_at = excluded.updated_at
        `).run(id, provenance.observedIdentifier, provenance.status, provenance.streamerId,
            provenance.alias, provenance.streamerUrl, provenance.aliasUrl,
            provenance.reason, provenance.updatedAt);
        const saved = this.getProvenance(id);
        if (!saved) throw new Error(`Failed to save provenance for ${id}`);
        return saved;
    }

    saveManualProvenance(id: string, input: {
        observedIdentifier?: string;
        streamerId: string;
        alias: string;
        streamerUrl: string;
        aliasUrl?: string | null;
    }, now = new Date()): RecordingProvenance {
        const recording = this.requireRecording(id);
        const current = this.getProvenance(id);
        const observedIdentifier = input.observedIdentifier ?? current?.observedIdentifier ?? input.alias;
        const manual = {
            observedIdentifier,
            status: "manual",
            streamerId: input.streamerId.trim(),
            alias: input.alias.trim(),
            streamerUrl: input.streamerUrl.trim(),
            aliasUrl: input.aliasUrl?.trim() || null,
            reason: null,
            updatedAt: now.toISOString(),
        } as const;
        this.validateProvenance(manual);
        this.database.prepare(`
            INSERT INTO provenance_overrides (
                provider, observed_identifier, streamer_id, alias,
                streamer_url, alias_url, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(provider, observed_identifier) DO UPDATE SET
                streamer_id = excluded.streamer_id,
                alias = excluded.alias,
                streamer_url = excluded.streamer_url,
                alias_url = excluded.alias_url,
                updated_at = excluded.updated_at
        `).run(recording.provider, observedIdentifier, manual.streamerId, manual.alias,
            manual.streamerUrl, manual.aliasUrl, manual.updatedAt);
        const affected = this.database.prepare(`
            SELECT p.recording_id FROM recording_provenance p
            JOIN recordings r ON r.id = p.recording_id
            WHERE r.provider = ? AND p.observed_identifier = ?
        `).all(recording.provider, observedIdentifier) as unknown as Array<{ recording_id: string }>;
        if (!affected.some((row) => row.recording_id === id)) affected.push({ recording_id: id });
        for (const row of affected) {
            this.saveProvenance(row.recording_id, manual);
            if (this.requireRecording(row.recording_id).state === "provenance_review_required") {
                this.transition(row.recording_id, "provenance_review_required", "described", "manual provenance supplied", now);
            }
        }
        const saved = this.getProvenance(id);
        if (!saved) throw new Error("Manual provenance disappeared");
        return saved;
    }

    getProvenanceOverride(provider: string, observedIdentifier: string, now = new Date()):
        Omit<RecordingProvenance, "recordingId"> | null {
        const row = this.database.prepare(`
            SELECT * FROM provenance_overrides WHERE provider = ? AND observed_identifier = ?
        `).get(provider, observedIdentifier) as {
            observed_identifier: string;
            streamer_id: string;
            alias: string;
            streamer_url: string;
            alias_url: string | null;
            updated_at: string;
        } | undefined;
        return row ? {
            observedIdentifier: row.observed_identifier,
            status: "manual",
            streamerId: row.streamer_id,
            alias: row.alias,
            streamerUrl: row.streamer_url,
            aliasUrl: row.alias_url,
            reason: null,
            updatedAt: row.updated_at || now.toISOString(),
        } : null;
    }

    getProvenance(id: string): RecordingProvenance | null {
        const row = this.database.prepare("SELECT * FROM recording_provenance WHERE recording_id = ?")
            .get(id) as ProvenanceRow | undefined;
        return row ? {
            recordingId: row.recording_id,
            observedIdentifier: row.observed_identifier,
            status: row.resolution_status,
            streamerId: row.streamer_id,
            alias: row.alias,
            streamerUrl: row.streamer_url,
            aliasUrl: row.alias_url,
            reason: row.reason,
            updatedAt: row.updated_at,
        } : null;
    }

    listProvenanceReview(): RecordingProvenance[] {
        const rows = this.database.prepare(`
            SELECT * FROM recording_provenance
            WHERE resolution_status = 'review_required' ORDER BY updated_at, recording_id
        `).all() as unknown as ProvenanceRow[];
        return rows.map((row) => ({
            recordingId: row.recording_id,
            observedIdentifier: row.observed_identifier,
            status: row.resolution_status,
            streamerId: row.streamer_id,
            alias: row.alias,
            streamerUrl: row.streamer_url,
            aliasUrl: row.alias_url,
            reason: row.reason,
            updatedAt: row.updated_at,
        }));
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

    claimNext(
        states: readonly PipelineState[],
        owner: string,
        leaseMilliseconds: number,
        now = new Date(),
        sourceKinds: readonly SourceKind[] = ["downloader", "edited"],
    ): Recording | null {
        if (states.length === 0 || sourceKinds.length === 0 || leaseMilliseconds <= 0) {
            throw new Error("claimNext needs states, source kinds, and a positive lease");
        }
        const timestamp = now.toISOString();
        const expiry = new Date(now.getTime() + leaseMilliseconds).toISOString();
        const placeholders = states.map(() => "?").join(", ");
        const sourcePlaceholders = sourceKinds.map(() => "?").join(", ");
        let claimedId: string | null = null;
        this.transaction(() => {
            const row = this.database.prepare(`
                SELECT id FROM recordings
                WHERE state IN (${placeholders})
                  AND source_kind IN (${sourcePlaceholders})
                  AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
                ORDER BY created_at, id LIMIT 1
            `).get(...states as SQLInputValue[], ...sourceKinds, timestamp) as { id: string } | undefined;
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

    claimRecording(
        id: string,
        states: readonly PipelineState[],
        owner: string,
        leaseMilliseconds: number,
        now = new Date(),
        sourceKinds: readonly SourceKind[] = ["downloader", "edited"],
    ): Recording | null {
        if (states.length === 0 || sourceKinds.length === 0 || leaseMilliseconds <= 0) {
            throw new Error("claimRecording needs states, source kinds, and a positive lease");
        }
        const timestamp = now.toISOString();
        const expiry = new Date(now.getTime() + leaseMilliseconds).toISOString();
        const statePlaceholders = states.map(() => "?").join(", ");
        const sourcePlaceholders = sourceKinds.map(() => "?").join(", ");
        const result = this.database.prepare(`
            UPDATE recordings SET lease_owner = ?, lease_expires_at = ?,
                attempt_count = attempt_count + 1, updated_at = ?
            WHERE id = ? AND state IN (${statePlaceholders})
              AND source_kind IN (${sourcePlaceholders})
              AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        `).run(owner, expiry, timestamp, id, ...states, ...sourceKinds, timestamp);
        return result.changes === 1 ? this.get(id) : null;
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
                "server_ready", "remuxed", "artifact_valid", "described", "metadata_ready",
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
            this.updateStateInTransaction(id, "server_ready", "remuxed", "stream-copy artifact published", timestamp);
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

    getDescription(id: string): DescriptionRecord | null {
        const row = this.database.prepare("SELECT * FROM descriptions WHERE recording_id = ?")
            .get(id) as DescriptionRow | undefined;
        if (!row) return null;
        return {
            recordingId: row.recording_id,
            artifactSha256: row.artifact_sha256,
            promptVersion: row.prompt_version,
            fps: row.fps,
            output: JSON.parse(row.output_json) as unknown,
            evidencePath: row.evidence_path,
            createdAt: row.created_at,
        };
    }

    markProvenanceReviewRequired(id: string, reason: string, now = new Date()): Recording {
        return this.transition(id, "described", "provenance_review_required", reason, now);
    }

    saveUploadMetadata(id: string, metadata: {
        title: string;
        description: string;
        tags: readonly string[];
        matchKey: string;
    }, now = new Date()): Recording {
        const recording = this.requireRecording(id);
        const provenance = this.getProvenance(id);
        if (recording.state !== "described") throw new Error(`Recording ${id} is not described`);
        if (!provenance || provenance.status === "review_required") {
            throw new Error(`Recording ${id} has unresolved provenance`);
        }
        if (!metadata.title || metadata.title.length > 255) throw new Error("Upload title must contain at most 255 characters");
        if (!metadata.description || metadata.description.length > 1_000) {
            throw new Error("Upload description must contain at most 1000 characters");
        }
        if (metadata.tags.length > 20 || metadata.tags.some((tag) => !tag.trim())) {
            throw new Error("Upload metadata allows at most twenty nonempty tags");
        }
        if (!metadata.matchKey || metadata.matchKey.length > 80 || !metadata.title.includes(metadata.matchKey)) {
            throw new Error("Upload title must contain its deterministic match key");
        }
        const timestamp = now.toISOString();
        this.transaction(() => {
            this.database.prepare(`
                INSERT INTO upload_metadata (
                    recording_id, title, description, tags_json, match_key, created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(recording_id) DO UPDATE SET
                    title = excluded.title,
                    description = excluded.description,
                    tags_json = excluded.tags_json,
                    match_key = excluded.match_key,
                    created_at = excluded.created_at
            `).run(id, metadata.title, metadata.description,
                JSON.stringify(metadata.tags), metadata.matchKey, timestamp);
            this.updateStateInTransaction(id, "described", "metadata_ready", "upload metadata composed", timestamp);
        });
        return this.requireRecording(id);
    }

    getUploadMetadata(id: string): UploadMetadataRecord | null {
        const row = this.database.prepare("SELECT * FROM upload_metadata WHERE recording_id = ?").get(id) as {
            recording_id: string;
            title: string;
            description: string;
            tags_json: string;
            match_key: string;
            created_at: string;
        } | undefined;
        if (!row) return null;
        const tags = JSON.parse(row.tags_json) as unknown;
        if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")) {
            throw new Error(`Upload metadata tags are invalid for ${id}`);
        }
        return {
            recordingId: row.recording_id,
            title: row.title,
            description: row.description,
            tags,
            matchKey: row.match_key,
            createdAt: row.created_at,
        };
    }

    saveStreamerModel(model: Omit<StreamerModelRecord, "updatedAt">, now = new Date()): StreamerModelRecord {
        for (const [name, value] of Object.entries(model)) {
            if (name !== "xvideosModelId" && (typeof value !== "string" || value.trim() === "")) {
                throw new Error(`Streamer model ${name} is required`);
            }
        }
        this.database.prepare(`
            INSERT INTO streamer_models (
                provider, streamer_id, stage_name, gender, how_known,
                profile_picture, xvideos_model_id, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(provider, streamer_id) DO UPDATE SET
                stage_name = excluded.stage_name,
                gender = excluded.gender,
                how_known = excluded.how_known,
                profile_picture = excluded.profile_picture,
                xvideos_model_id = COALESCE(excluded.xvideos_model_id, streamer_models.xvideos_model_id),
                updated_at = excluded.updated_at
        `).run(model.provider, model.streamerId, model.stageName, model.gender,
            model.howKnown, path.resolve(model.profilePicture), model.xvideosModelId, now.toISOString());
        const saved = this.getStreamerModel(model.provider, model.streamerId);
        if (!saved) throw new Error("Failed to save streamer model");
        return saved;
    }

    getStreamerModel(provider: string, streamerId: string): StreamerModelRecord | null {
        const row = this.database.prepare(`
            SELECT * FROM streamer_models WHERE provider = ? AND streamer_id = ?
        `).get(provider, streamerId) as {
            provider: string;
            streamer_id: string;
            stage_name: string;
            gender: string;
            how_known: string;
            profile_picture: string;
            xvideos_model_id: string | null;
            updated_at: string;
        } | undefined;
        return row ? {
            provider: row.provider,
            streamerId: row.streamer_id,
            stageName: row.stage_name,
            gender: row.gender,
            howKnown: row.how_known,
            profilePicture: row.profile_picture,
            xvideosModelId: row.xvideos_model_id,
            updatedAt: row.updated_at,
        } : null;
    }

    setRemoteModelId(provider: string, streamerId: string, xvideosModelId: string, now = new Date()): StreamerModelRecord {
        if (!xvideosModelId.trim()) throw new Error("XVideos model ID is required");
        const result = this.database.prepare(`
            UPDATE streamer_models SET xvideos_model_id = ?, updated_at = ?
            WHERE provider = ? AND streamer_id = ?
        `).run(xvideosModelId.trim(), now.toISOString(), provider, streamerId);
        if (result.changes !== 1) throw new Error(`No streamer model configured for ${provider}:${streamerId}`);
        const saved = this.getStreamerModel(provider, streamerId);
        if (!saved) throw new Error("Streamer model disappeared");
        return saved;
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
            if (recording.state !== "metadata_ready") throw new Error(`Recording ${id} has no upload-ready metadata`);
            const usage = this.uploadUsage(month);
            if (usage.spent + usage.reserved + bytes > limit) throw new Error(`Monthly upload limit exceeded for ${month}`);
            this.database.prepare(`
                INSERT INTO upload_reservations (
                    id, recording_id, provider, calendar_month, reserved_bytes,
                    status, created_at, updated_at
                ) VALUES (?, ?, 'xvideos', ?, ?, 'reserved', ?, ?)
            `).run(reservationId, id, month, bytes, timestamp, timestamp);
            this.updateStateInTransaction(id, "metadata_ready", "xvideos_admitted", "monthly bytes reserved", timestamp);
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

    updateUploadProgress(
        attemptId: string,
        phase: "file_uploading" | "file_uploaded" | "metadata_submitting",
        transmittedBytes: number,
        now = new Date(),
    ): void {
        if (!Number.isSafeInteger(transmittedBytes) || transmittedBytes < 0) {
            throw new Error("Upload progress bytes must be a nonnegative integer");
        }
        const order = { started: 0, file_uploading: 1, file_uploaded: 2, metadata_submitting: 3 } as const;
        const row = this.database.prepare(`
            SELECT phase, progress_bytes FROM upload_attempts WHERE id = ? AND status = 'started'
        `).get(attemptId) as { phase: keyof typeof order; progress_bytes: number } | undefined;
        if (!row) throw new Error(`Upload attempt ${attemptId} is not active`);
        if (order[phase] < order[row.phase] || transmittedBytes < row.progress_bytes) {
            throw new Error("Upload progress cannot move backwards");
        }
        // Keep the persisted phase at `started` while bytes are in flight. Older
        // schema-v3 databases enforce the original three-value CHECK constraint;
        // progress_bytes still makes interrupted partial/full transfers billable.
        const persistedPhase = phase === "file_uploading" ? "started" : phase;
        this.database.prepare(`
            UPDATE upload_attempts SET phase = ?, progress_bytes = ? WHERE id = ?
        `).run(persistedPhase, transmittedBytes, attemptId);
        const recording = this.database.prepare("SELECT recording_id FROM upload_attempts WHERE id = ?")
            .get(attemptId) as { recording_id: string };
        this.database.prepare("UPDATE recordings SET updated_at = ? WHERE id = ?")
            .run(now.toISOString(), recording.recording_id);
    }

    getUploadProgress(attemptId: string): {
        phase: "started" | "file_uploading" | "file_uploaded" | "metadata_submitting";
        transmittedBytes: number;
    } {
        const row = this.database.prepare(`
            SELECT phase, progress_bytes FROM upload_attempts WHERE id = ? AND status = 'started'
        `).get(attemptId) as {
            phase: "started" | "file_uploading" | "file_uploaded" | "metadata_submitting";
            progress_bytes: number;
        } | undefined;
        if (!row) throw new Error(`Upload attempt ${attemptId} is not active`);
        return { phase: row.phase, transmittedBytes: row.progress_bytes };
    }

    recoverInterruptedUploads(now = new Date()): Array<{ recordingId: string; disposition: string }> {
        const timestamp = now.toISOString();
        const attempts = this.database.prepare(`
            SELECT a.id, a.recording_id, a.reservation_id, a.phase, a.progress_bytes,
                r.calendar_month, m.match_key
            FROM upload_attempts a
            JOIN upload_reservations r ON r.id = a.reservation_id
            LEFT JOIN upload_metadata m ON m.recording_id = a.recording_id
            JOIN recordings rec ON rec.id = a.recording_id
            WHERE a.status = 'started' AND rec.state = 'xvideos_uploading'
            ORDER BY a.started_at, a.id
        `).all() as unknown as Array<{
            id: string;
            recording_id: string;
            reservation_id: string;
            phase: "started" | "file_uploading" | "file_uploaded" | "metadata_submitting";
            progress_bytes: number;
            calendar_month: string;
            match_key: string | null;
        }>;
        const results: Array<{ recordingId: string; disposition: string }> = [];
        for (const attempt of attempts) {
            this.transaction(() => {
                const uncertain = attempt.phase === "metadata_submitting" || attempt.phase === "file_uploaded";
                if (attempt.progress_bytes > 0) {
                    this.database.prepare(`
                        INSERT INTO bandwidth_events (
                            recording_id, attempt_id, provider, calendar_month,
                            transmitted_bytes, created_at
                        ) VALUES (?, ?, 'xvideos', ?, ?, ?)
                    `).run(attempt.recording_id, attempt.id, attempt.calendar_month,
                        attempt.progress_bytes, timestamp);
                }
                this.database.prepare(`
                    UPDATE upload_attempts SET status = ?, transmitted_bytes = ?, error = ?, completed_at = ?
                    WHERE id = ? AND status = 'started'
                `).run(uncertain ? "uncertain" : "failed", attempt.progress_bytes,
                    `process interrupted during ${attempt.phase}`, timestamp, attempt.id);
                this.database.prepare(`
                    UPDATE upload_reservations SET status = 'released', updated_at = ? WHERE id = ?
                `).run(timestamp, attempt.reservation_id);
                if (uncertain) {
                    if (!attempt.match_key) throw new Error("Interrupted metadata submission has no match key");
                    this.database.prepare(`
                        INSERT INTO upload_confirmations (
                            attempt_id, recording_id, match_key, confirm_after, status, checked_at
                        ) VALUES (?, ?, ?, ?, 'pending', NULL)
                    `).run(attempt.id, attempt.recording_id, attempt.match_key,
                        new Date(now.getTime() + 24 * 60 * 60_000).toISOString());
                    this.updateStateInTransaction(attempt.recording_id, "xvideos_uploading", "xvideos_uncertain",
                        "interrupted while metadata submission may have been accepted", timestamp);
                } else {
                    this.updateStateInTransaction(attempt.recording_id, "xvideos_uploading", "metadata_ready",
                        `interrupted during ${attempt.phase}; safe to retry`, timestamp);
                }
                results.push({
                    recordingId: attempt.recording_id,
                    disposition: uncertain ? "confirmation_required" : "retryable",
                });
            });
        }
        return results;
    }

    finishUploadAttempt(attemptId: string, outcome: {
        status: "failed" | "accepted" | "uncertain";
        transmittedBytes: number;
        remoteId?: string;
        remoteUrl?: string;
        error?: string;
        confirmation?: { matchKey: string; confirmAfter: Date };
    }, now = new Date()): Recording {
        if (!Number.isSafeInteger(outcome.transmittedBytes) || outcome.transmittedBytes < 0) {
            throw new Error("transmittedBytes must be a nonnegative integer");
        }
        const timestamp = now.toISOString();
        let recordingId = "";
        this.transaction(() => {
            const attempt = this.database.prepare(`
                SELECT a.recording_id, a.reservation_id, a.progress_bytes,
                    r.reserved_bytes, r.calendar_month
                FROM upload_attempts a JOIN upload_reservations r ON r.id = a.reservation_id
                WHERE a.id = ? AND a.status = 'started'
            `).get(attemptId) as {
                recording_id: string;
                reservation_id: string;
                reserved_bytes: number;
                calendar_month: string;
                progress_bytes: number;
            } | undefined;
            if (!attempt) throw new Error(`Upload attempt ${attemptId} is not active`);
            if (outcome.transmittedBytes > attempt.reserved_bytes) {
                throw new Error("Transmitted bytes exceed the upload reservation");
            }
            if (outcome.transmittedBytes < attempt.progress_bytes) {
                throw new Error("Final transmitted bytes cannot be lower than persisted upload progress");
            }
            if (outcome.status === "accepted" && (!outcome.remoteId || !outcome.remoteUrl)) {
                throw new Error("Accepted upload requires remoteId and remoteUrl");
            }
            if (outcome.status === "uncertain" && !outcome.confirmation) {
                throw new Error("Uncertain upload requires a durable confirmation deadline");
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
            if (outcome.status === "uncertain" && outcome.confirmation) {
                this.database.prepare(`
                    INSERT INTO upload_confirmations (
                        attempt_id, recording_id, match_key, confirm_after, status, checked_at
                    ) VALUES (?, ?, ?, ?, 'pending', NULL)
                `).run(attemptId, recordingId, outcome.confirmation.matchKey,
                    outcome.confirmation.confirmAfter.toISOString());
            }
            const next: PipelineState = outcome.status === "accepted"
                ? "xvideos_uploaded"
                : outcome.status === "uncertain" ? "xvideos_uncertain" : "metadata_ready";
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
            this.database.prepare(`
                UPDATE upload_confirmations SET status = 'found', checked_at = ? WHERE attempt_id = ?
            `).run(timestamp, attemptId);
            this.updateStateInTransaction(recordingId, "xvideos_uncertain", "xvideos_uploaded",
                "manual reconciliation found accepted remote upload", timestamp);
        });
        return this.requireRecording(recordingId);
    }

    markRemoteVerified(
        id: string,
        remoteId: string,
        remoteUrl: string,
        moderationStatus: string | null = null,
        now = new Date(),
    ): Recording {
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
            this.database.prepare(`
                INSERT INTO xvideos_entries (
                    recording_id, attempt_id, remote_id, remote_url, moderation_status, observed_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(recording_id) DO UPDATE SET
                    attempt_id = excluded.attempt_id,
                    remote_id = excluded.remote_id,
                    remote_url = excluded.remote_url,
                    moderation_status = excluded.moderation_status,
                    observed_at = excluded.observed_at
            `).run(id, attempt.id, remoteId, remoteUrl, moderationStatus, timestamp);
            this.updateStateInTransaction(id, "xvideos_uploaded", "xvideos_verified",
                "authenticated XVideos uploads-list entry verified", timestamp);
        });
        return this.requireRecording(id);
    }

    dueUploadConfirmations(now = new Date()): UploadConfirmation[] {
        const rows = this.database.prepare(`
            SELECT c.*, a.recording_id
            FROM upload_confirmations c JOIN upload_attempts a ON a.id = c.attempt_id
            WHERE c.status = 'pending' AND c.confirm_after <= ?
            ORDER BY c.confirm_after, c.attempt_id
        `).all(now.toISOString()) as unknown as Array<{
            attempt_id: string;
            recording_id: string;
            match_key: string;
            confirm_after: string;
            status: UploadConfirmation["status"];
            checked_at: string | null;
        }>;
        return rows.map((row) => ({
            attemptId: row.attempt_id,
            recordingId: row.recording_id,
            matchKey: row.match_key,
            confirmAfter: row.confirm_after,
            status: row.status,
            checkedAt: row.checked_at,
        }));
    }

    markConfirmationAbsent(attemptId: string, now = new Date()): Recording {
        const timestamp = now.toISOString();
        let recordingId = "";
        this.transaction(() => {
            const row = this.database.prepare(`
                SELECT c.recording_id FROM upload_confirmations c
                JOIN upload_attempts a ON a.id = c.attempt_id
                WHERE c.attempt_id = ? AND c.status = 'pending'
                  AND c.confirm_after <= ? AND a.status = 'uncertain'
            `).get(attemptId, timestamp) as { recording_id: string } | undefined;
            if (!row) throw new Error(`Upload confirmation ${attemptId} is not due`);
            recordingId = row.recording_id;
            this.database.prepare(`
                UPDATE upload_confirmations SET status = 'absent', checked_at = ? WHERE attempt_id = ?
            `).run(timestamp, attemptId);
            this.database.prepare(`
                UPDATE upload_attempts SET status = 'failed', error = ?, completed_at = ? WHERE id = ?
            `).run("no matching uploads-list entry after 24-hour grace period", timestamp, attemptId);
            this.updateStateInTransaction(recordingId, "xvideos_uncertain", "metadata_ready",
                "no matching uploads-list entry after 24-hour grace period", timestamp);
        });
        return this.requireRecording(recordingId);
    }

    private validateProvenance(provenance: Omit<RecordingProvenance, "recordingId">): void {
        if (!provenance.observedIdentifier.trim()) throw new Error("Observed recording identifier is required");
        if (provenance.status === "review_required") return;
        if (!provenance.streamerId?.trim() || !provenance.alias?.trim() || !provenance.streamerUrl?.trim()) {
            throw new Error("Resolved provenance requires streamer ID, alias, and streamer URL");
        }
        for (const candidate of [provenance.streamerUrl, provenance.aliasUrl]) {
            if (!candidate) continue;
            const url = new URL(candidate);
            if (url.protocol !== "https:") throw new Error("Streamer links must use HTTPS");
        }
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
