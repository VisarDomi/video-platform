import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { CURRENT_PRODUCTION_VERSION } from "../domain/productionVersion.js";
import { allowsUpload, allowsPlaceholder } from "../provenance/uploadPolicy.js";
import { isRemovalPendingStatus, limitedVisibilityWarning, rejectedPhrases } from "../upload/providerWarnings.js";
import { assertTransition, type PipelineState } from "../domain/states.js";
import type { ManualPiece } from "../scheduler/orchestrator.js";
import { assertUploadProvider, type ActiveUploadProvider } from "../config/uploadProviders.js";
import type {
    ProviderInventoryEntry,
    ArtifactRecord,
    ArtifactVariant,
    ArtifactVariantRecord,
    CampaignControl,
    CampaignProviderFilter,
    DescriptionRecord,
    ProductionArtifactPart,
    QueuedProductionArtifactRecord,
    Recording,
    RecordingInput,
    RecordingProvenance,
    ResolutionReviewArtifactRecord,
    ResolutionReviewPart,
    SourceKind,
    UploadConfirmation,
    UploadMetadataRecord,
} from "../domain/types.js";

const SCHEMA_VERSION = 12;

// Production artifact parts: the old 1080p split names, or "shapeN" (one upload
// per picture shape, 2026-10-05). Kept in SQL so a bad name cannot be stored.
function partCheck(column: string): string {
    return `${column} IN ('full', 'max1080p', 'nonmax1080p') OR (${column} GLOB 'shape[1-9]*' AND ${column} NOT GLOB 'shape*[^0-9]*')`;
}
function queuedPartCheck(column: string): string {
    return `${column} IN ('max1080p', 'nonmax1080p') OR (${column} GLOB 'shape[1-9]*' AND ${column} NOT GLOB 'shape*[^0-9]*')`;
}
// Schema 11 text of the checks above, replaced when a table is rebuilt.
const LEGACY_PART_CHECKS: ReadonlyArray<readonly [string, string]> = [
    ["CHECK (part IN ('full', 'max1080p', 'nonmax1080p'))", `CHECK (${partCheck("part")})`],
    ["CHECK (artifact_part IN ('full', 'max1080p', 'nonmax1080p'))", `CHECK (${partCheck("artifact_part")})`],
    ["CHECK (part IN ('max1080p', 'nonmax1080p'))", `CHECK (${queuedPartCheck("part")})`],
];
const UPLOAD_RETRY_MILLISECONDS = 7 * 24 * 60 * 60_000;
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

interface ProductionArtifactRow extends ArtifactRow {
    part: ProductionArtifactPart;
}

interface QueuedProductionArtifactRow extends ProductionArtifactRow {
    segment_count: number;
    source_dimensions_json: string;
    queue_position: number;
}

interface ArtifactVariantRow extends ArtifactRow {
    variant: ArtifactVariant;
    source_frame_count: number;
    dropped_source_frames: number;
}

interface ResolutionReviewArtifactRow extends ArtifactRow {
    part: ResolutionReviewPart;
    segment_count: number;
    source_dimensions_json: string;
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
    // The folder name (datetime + alias) is the identity; the disk is the
    // source of truth.
    const basename = path.basename(path.resolve(input.sourcePath));
    if (basename) return basename;
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

function mapQueuedProductionArtifact(row: QueuedProductionArtifactRow): QueuedProductionArtifactRecord {
    const sourceDimensions = JSON.parse(row.source_dimensions_json) as unknown;
    if (!Array.isArray(sourceDimensions) || !sourceDimensions.every((value) => typeof value === "string")) {
        throw new Error(`Invalid queued artifact dimensions for ${row.recording_id}/${row.part}`);
    }
    if (row.part === "full") throw new Error("A full artifact cannot be queued");
    return {
        ...mapArtifact(row),
        part: row.part,
        segmentCount: row.segment_count,
        sourceDimensions,
    };
}

function mapArtifactVariant(row: ArtifactVariantRow): ArtifactVariantRecord {
    return {
        ...mapArtifact(row),
        variant: row.variant,
        sourceFrameCount: row.source_frame_count,
        droppedSourceFrames: row.dropped_source_frames,
    };
}

function mapResolutionReviewArtifact(row: ResolutionReviewArtifactRow): ResolutionReviewArtifactRecord {
    const sourceDimensions = JSON.parse(row.source_dimensions_json) as unknown;
    if (!Array.isArray(sourceDimensions) || !sourceDimensions.every((value) => typeof value === "string")) {
        throw new Error(`Invalid source dimensions for resolution-review artifact ${row.recording_id}/${row.part}`);
    }
    return {
        ...mapArtifact(row),
        part: row.part,
        segmentCount: row.segment_count,
        sourceDimensions,
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
        const existingSchema = this.database.prepare(`
            SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'
        `).get() as { present: number } | undefined;
        const isNewDatabase = existingSchema === undefined;
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
                part TEXT NOT NULL DEFAULT 'full' CHECK (${partCheck("part")}),
                path TEXT NOT NULL UNIQUE,
                size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
                sha256 TEXT NOT NULL,
                validated_at TEXT NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS production_artifact_queue (
                recording_id TEXT NOT NULL REFERENCES recordings(id),
                part TEXT NOT NULL CHECK (${queuedPartCheck("part")}),
                queue_position INTEGER NOT NULL CHECK (queue_position >= 0),
                path TEXT NOT NULL UNIQUE,
                size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
                sha256 TEXT NOT NULL,
                segment_count INTEGER NOT NULL CHECK (segment_count > 0),
                source_dimensions_json TEXT NOT NULL,
                validated_at TEXT NOT NULL,
                PRIMARY KEY (recording_id, part),
                UNIQUE (recording_id, queue_position)
            ) STRICT;
            CREATE TABLE IF NOT EXISTS artifact_variants (
                recording_id TEXT NOT NULL REFERENCES recordings(id),
                variant TEXT NOT NULL CHECK (variant IN ('upscale1080p', 'upscale1440p')),
                path TEXT NOT NULL UNIQUE,
                size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
                sha256 TEXT NOT NULL,
                source_frame_count INTEGER NOT NULL CHECK (source_frame_count > 0),
                dropped_source_frames INTEGER NOT NULL CHECK (
                    dropped_source_frames >= 0 AND dropped_source_frames < source_frame_count
                ),
                validated_at TEXT NOT NULL,
                PRIMARY KEY (recording_id, variant)
            ) STRICT;
            CREATE TABLE IF NOT EXISTS resolution_review_artifacts (
                recording_id TEXT NOT NULL REFERENCES recordings(id),
                part TEXT NOT NULL CHECK (part IN ('max1080p', 'nonmax')),
                path TEXT NOT NULL UNIQUE,
                size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
                sha256 TEXT NOT NULL,
                segment_count INTEGER NOT NULL CHECK (segment_count > 0),
                source_dimensions_json TEXT NOT NULL,
                validated_at TEXT NOT NULL,
                PRIMARY KEY (recording_id, part)
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
                artifact_part TEXT NOT NULL DEFAULT 'full' CHECK (${partCheck("artifact_part")}),
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
                reservation_id TEXT REFERENCES upload_reservations(id),
                recording_id TEXT NOT NULL REFERENCES recordings(id),
                artifact_part TEXT NOT NULL DEFAULT 'full' CHECK (${partCheck("artifact_part")}),
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
                recording_id TEXT NOT NULL,
                attempt_id TEXT NOT NULL,
                provider TEXT NOT NULL,
                calendar_month TEXT NOT NULL,
                transmitted_bytes INTEGER NOT NULL CHECK (transmitted_bytes >= 0),
                created_at TEXT NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS remote_uploads (
                recording_id TEXT NOT NULL REFERENCES recordings(id),
                artifact_part TEXT NOT NULL DEFAULT 'full' CHECK (${partCheck("artifact_part")}),
                attempt_id TEXT NOT NULL,
                remote_id TEXT NOT NULL,
                remote_url TEXT NOT NULL,
                verified_at TEXT NOT NULL,
                PRIMARY KEY (recording_id, artifact_part),
                UNIQUE (attempt_id)
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
                created_at TEXT NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS upload_confirmations (
                attempt_id TEXT PRIMARY KEY REFERENCES upload_attempts(id),
                recording_id TEXT NOT NULL REFERENCES recordings(id),
                confirm_after TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('pending', 'found', 'absent')),
                checked_at TEXT
            ) STRICT;
            CREATE INDEX IF NOT EXISTS upload_confirmations_due_idx
                ON upload_confirmations (status, confirm_after);
            CREATE TABLE IF NOT EXISTS worker_heartbeat (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                updated_at TEXT NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS campaign_control (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                state TEXT NOT NULL CHECK (state IN ('paused', 'running')),
                provider_filter TEXT NOT NULL CHECK (provider_filter IN ('all', 'tango', 'fc2', 'sc')),
                ordering TEXT NOT NULL CHECK (ordering = 'oldest'),
                monthly_upload_limit_bytes INTEGER NOT NULL CHECK (monthly_upload_limit_bytes > 0),
                antibot_failures INTEGER NOT NULL DEFAULT 0,
                resume_at TEXT,
                updated_at TEXT NOT NULL
            ) STRICT;
            INSERT OR IGNORE INTO campaign_control (
                id, state, provider_filter, ordering, monthly_upload_limit_bytes, updated_at
            ) VALUES (1, 'paused', 'all', 'oldest', ${DEFAULT_MONTHLY_UPLOAD_LIMIT_BYTES}, '1970-01-01T00:00:00.000Z');
            CREATE TABLE IF NOT EXISTS production_version (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                version TEXT NOT NULL,
                activated_at TEXT NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS campaign_trial_recordings (
                recording_id TEXT PRIMARY KEY,
                provider TEXT NOT NULL CHECK (provider IN ('tango', 'fc2', 'sc')),
                admitted_at TEXT NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS comparison_trial (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                selection_json TEXT NOT NULL,
                selection_errors_json TEXT NOT NULL DEFAULT '[]',
                locked_at TEXT,
                completed_at TEXT
            ) STRICT;
            CREATE TABLE IF NOT EXISTS production_rollovers (
                id INTEGER PRIMARY KEY,
                from_version TEXT NOT NULL,
                to_version TEXT NOT NULL,
                retired_recordings INTEGER NOT NULL CHECK (retired_recordings >= 0),
                retired_remote_uploads INTEGER NOT NULL CHECK (retired_remote_uploads >= 0),
                preserved_bandwidth_bytes INTEGER NOT NULL CHECK (preserved_bandwidth_bytes >= 0),
                created_at TEXT NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS retired_recordings (
                production_version TEXT NOT NULL,
                recording_id TEXT NOT NULL,
                provider TEXT NOT NULL,
                source_path TEXT NOT NULL,
                state TEXT NOT NULL,
                block_reason TEXT,
                created_at TEXT NOT NULL,
                retired_at TEXT NOT NULL,
                PRIMARY KEY (production_version, recording_id)
            ) STRICT;
            CREATE TABLE IF NOT EXISTS retired_upload_attempts (
                production_version TEXT NOT NULL,
                attempt_id TEXT NOT NULL,
                recording_id TEXT NOT NULL,
                artifact_part TEXT NOT NULL,
                status TEXT NOT NULL,
                phase TEXT NOT NULL,
                transmitted_bytes INTEGER NOT NULL,
                remote_id TEXT,
                remote_url TEXT,
                error TEXT,
                started_at TEXT NOT NULL,
                completed_at TEXT,
                retired_at TEXT NOT NULL,
                PRIMARY KEY (production_version, attempt_id)
            ) STRICT;
            CREATE TABLE IF NOT EXISTS retired_remote_uploads (
                production_version TEXT NOT NULL,
                recording_id TEXT NOT NULL,
                artifact_part TEXT NOT NULL,
                attempt_id TEXT NOT NULL,
                remote_id TEXT NOT NULL,
                remote_url TEXT NOT NULL,
                verified_at TEXT NOT NULL,
                retired_at TEXT NOT NULL,
                PRIMARY KEY (production_version, recording_id, artifact_part)
            ) STRICT;
            CREATE TABLE IF NOT EXISTS rejected_phrases (
                provider TEXT NOT NULL,
                phrase TEXT NOT NULL,
                first_seen_at TEXT NOT NULL,
                attempt_id TEXT,
                PRIMARY KEY (provider, phrase)
            ) STRICT;
            CREATE TABLE IF NOT EXISTS provider_inventory (
                provider TEXT NOT NULL,
                remote_id TEXT NOT NULL,
                recording_id TEXT,
                title TEXT NOT NULL,
                remote_url TEXT,
                status TEXT NOT NULL,
                removal_pending INTEGER NOT NULL DEFAULT 0 CHECK (removal_pending IN (0, 1)),
                observed_at TEXT NOT NULL,
                PRIMARY KEY (provider, remote_id)
            ) STRICT;
            CREATE INDEX IF NOT EXISTS provider_inventory_recording_idx ON provider_inventory (recording_id);
            CREATE TABLE IF NOT EXISTS provider_inventory_syncs (
                provider TEXT PRIMARY KEY,
                completed_at TEXT NOT NULL,
                total INTEGER NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS provider_session_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                provider TEXT NOT NULL,
                occurred_at TEXT NOT NULL,
                kind TEXT NOT NULL,
                logged_in INTEGER,
                fingerprint TEXT,
                password_login_at TEXT,
                note TEXT
            ) STRICT;
            CREATE INDEX IF NOT EXISTS provider_session_events_idx ON provider_session_events (provider, occurred_at);
            CREATE TABLE IF NOT EXISTS upload_provider_events (
                changed_at TEXT NOT NULL,
                from_provider TEXT NOT NULL,
                to_provider TEXT NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS manual_pieces (
                recording_id TEXT NOT NULL REFERENCES recordings(id),
                part TEXT NOT NULL,
                segment_indexes_json TEXT NOT NULL,
                duration_seconds REAL NOT NULL CHECK (duration_seconds >= 0),
                source_dimensions_json TEXT NOT NULL,
                reason TEXT NOT NULL,
                recorded_at TEXT NOT NULL,
                PRIMARY KEY (recording_id, part)
            ) STRICT;
            -- Uploads a provider took down. Kept across generations: that
            -- provider never gets the recording again.
            CREATE TABLE IF NOT EXISTS provider_removals (
                recording_id TEXT NOT NULL,
                provider TEXT NOT NULL CHECK (provider IN ('xvideos', 'porntrex')),
                remote_id TEXT NOT NULL,
                reason TEXT NOT NULL,
                removed_at TEXT NOT NULL,
                PRIMARY KEY (recording_id, provider, remote_id)
            ) STRICT;
        `);
        const controlColumns = this.database.prepare("PRAGMA table_info(campaign_control)").all() as unknown as Array<{ name: string }>;
        const comparisonColumns = this.database.prepare("PRAGMA table_info(comparison_trial)").all() as unknown as Array<{ name: string }>;
        if (!comparisonColumns.some((column) => column.name === "selection_errors_json")) {
            this.database.exec("ALTER TABLE comparison_trial ADD COLUMN selection_errors_json TEXT NOT NULL DEFAULT '[]'");
        }
        if (!controlColumns.some((column) => column.name === "antibot_failures")) {
            this.database.exec("ALTER TABLE campaign_control ADD COLUMN antibot_failures INTEGER NOT NULL DEFAULT 0");
        }
        if (!controlColumns.some((column) => column.name === "resume_at")) {
            this.database.exec("ALTER TABLE campaign_control ADD COLUMN resume_at TEXT");
        }
        if (!controlColumns.some((column) => column.name === "trial_per_provider")) {
            this.database.exec("ALTER TABLE campaign_control ADD COLUMN trial_per_provider INTEGER CHECK (trial_per_provider > 0)");
        }
        if (!controlColumns.some((column) => column.name === "trial_finished_at")) {
            this.database.exec("ALTER TABLE campaign_control ADD COLUMN trial_finished_at TEXT");
        }
        if (!controlColumns.some((column) => column.name === "attention_reason")) {
            this.database.exec("ALTER TABLE campaign_control ADD COLUMN attention_reason TEXT");
        }
        if (!controlColumns.some((column) => column.name === "upload_provider")) {
            // The one active destination is campaign intent, not a credential.
            this.database.exec(`ALTER TABLE campaign_control ADD COLUMN upload_provider TEXT NOT NULL DEFAULT 'xvideos'
                CHECK (upload_provider IN ('xvideos', 'porntrex'))`);
        }
        const inventoryColumns = this.database.prepare("PRAGMA table_info(provider_inventory)").all() as unknown as Array<{ name: string }>;
        if (!inventoryColumns.some((column) => column.name === "removal_pending")) {
            this.database.exec(`ALTER TABLE provider_inventory ADD COLUMN removal_pending INTEGER NOT NULL DEFAULT 0
                CHECK (removal_pending IN (0, 1))`);
        }
        // Same rule as isRemovalPendingStatus, for rows stored before the column.
        this.database.exec("UPDATE provider_inventory SET removal_pending = 1 WHERE removal_pending = 0 AND lower(status) LIKE '%delet%'");
        const attemptColumns = this.database.prepare("PRAGMA table_info(upload_attempts)").all() as unknown as Array<{ name: string }>;
        for (const column of ["retry_not_before", "lookup_state", "lookup_checked_at", "limited_visibility", "metadata_rejection"]) {
            if (!attemptColumns.some((existing) => existing.name === column)) {
                this.database.exec(`ALTER TABLE upload_attempts ADD COLUMN ${column} TEXT`);
            }
        }
        this.database.exec(`UPDATE upload_attempts SET retry_not_before =
            strftime('%Y-%m-%dT%H:%M:%fZ', started_at, '+7 days') WHERE retry_not_before IS NULL`);
        if (!attemptColumns.some((column) => column.name === "evidence_json")) {
            this.database.exec("ALTER TABLE upload_attempts ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '[]'");
        }
        // Preserve warning evidence from pre-upgrade attempts before daily
        // checks rotate it out of the bounded diagnostic history.
        {
            // Idempotent even if power failed after adding the column but
            // before backfilling it. Only rows with possible warning text need parsing.
            const rows = this.database.prepare(`SELECT id, evidence_json FROM upload_attempts
                WHERE limited_visibility IS NULL AND metadata_rejection IS NULL
                AND (evidence_json LIKE '%not allowed here%' OR evidence_json LIKE '%limited visibility%')`)
                .all() as unknown as Array<{ id: string; evidence_json: string }>;
            for (const row of rows) {
                for (const evidence of JSON.parse(row.evidence_json) as Array<{ text?: string }>) {
                    this.recordProviderMessages(row.id, evidence.text ?? "", new Date());
                }
            }
        }
        // Removals recorded before their table, from the reconcile's own reason
        // text; an owner's deliberate deletion is worded differently.
        this.database.exec(`INSERT OR IGNORE INTO provider_removals (recording_id, provider, remote_id, reason, removed_at)
            SELECT a.recording_id, CASE WHEN a.provider = 'porntrex' THEN 'porntrex' ELSE 'xvideos' END,
                json_extract(e.value, '$.remoteId'), json_extract(e.value, '$.reason'), json_extract(e.value, '$.checkedAt')
            FROM upload_attempts a, json_each(a.evidence_json) e
            WHERE a.evidence_json LIKE '%provider_removed%' AND json_extract(e.value, '$.stage') = 'provider_removed'
                AND json_extract(e.value, '$.remoteId') IS NOT NULL
                AND json_extract(e.value, '$.reason') LIKE '% removed video % after upload%'`);
        if (!attemptColumns.some((column) => column.name === "transfer_started")) {
            this.database.exec("ALTER TABLE upload_attempts ADD COLUMN transfer_started INTEGER NOT NULL DEFAULT 0");
        }
        if (!attemptColumns.some((column) => column.name === "phase")) {
            this.database.exec("ALTER TABLE upload_attempts ADD COLUMN phase TEXT NOT NULL DEFAULT 'started'");
        }
        if (!attemptColumns.some((column) => column.name === "progress_bytes")) {
            this.database.exec("ALTER TABLE upload_attempts ADD COLUMN progress_bytes INTEGER NOT NULL DEFAULT 0");
        }
        const artifactColumns = this.database.prepare("PRAGMA table_info(artifacts)").all() as unknown as Array<{ name: string }>;
        if (!artifactColumns.some((column) => column.name === "part")) {
            this.database.exec("ALTER TABLE artifacts ADD COLUMN part TEXT NOT NULL DEFAULT 'full'");
        }
        const reservationColumns = this.database.prepare("PRAGMA table_info(upload_reservations)").all() as unknown as Array<{ name: string }>;
        if (!reservationColumns.some((column) => column.name === "artifact_part")) {
            this.database.exec("ALTER TABLE upload_reservations ADD COLUMN artifact_part TEXT NOT NULL DEFAULT 'full'");
        }
        if (!attemptColumns.some((column) => column.name === "artifact_part")) {
            this.database.exec("ALTER TABLE upload_attempts ADD COLUMN artifact_part TEXT NOT NULL DEFAULT 'full'");
        }
        const version = this.database.prepare("SELECT version FROM schema_version").get() as { version: number };
        if (version.version >= 2 && version.version < SCHEMA_VERSION) {
            const remoteColumns = this.database.prepare("PRAGMA table_info(remote_uploads)").all() as unknown as Array<{ name: string }>;
            if (!remoteColumns.some((column) => column.name === "artifact_part")) {
                this.database.exec(`
                    CREATE TABLE remote_uploads_v7 (
                        recording_id TEXT NOT NULL REFERENCES recordings(id),
                        artifact_part TEXT NOT NULL DEFAULT 'full' CHECK (artifact_part IN ('full', 'max1080p', 'nonmax1080p')),
                        attempt_id TEXT NOT NULL,
                        remote_id TEXT NOT NULL,
                        remote_url TEXT NOT NULL,
                        verified_at TEXT NOT NULL,
                        PRIMARY KEY (recording_id, artifact_part),
                        UNIQUE (attempt_id)
                    ) STRICT;
                    INSERT INTO remote_uploads_v7 (
                        recording_id, artifact_part, attempt_id, remote_id, remote_url, verified_at
                    ) SELECT recording_id, 'full', attempt_id, remote_id, remote_url, verified_at FROM remote_uploads;
                    DROP TABLE remote_uploads;
                    ALTER TABLE remote_uploads_v7 RENAME TO remote_uploads;
                `);
            }
            this.rebuildLegacyPartChecks();
            this.database.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
        } else if (version.version !== SCHEMA_VERSION) {
            throw new Error(`Unsupported pipeline schema version ${version.version}`);
        }
        // Repair the old manual-sync label, without changing identity or retry
        // state. Only known legacy source names and XVideos links qualify.
        this.database.prepare(`UPDATE upload_attempts SET provider = 'xvideos'
            WHERE provider IN ('tango', 'fc2', 'sc') AND remote_id IS NOT NULL
                AND (remote_url IS NULL OR remote_url LIKE 'https://www.xvideos.com/%')`).run();
        // Older code stored metadata word rejections as a visibility warning,
        // which also blocked their retry. Split them out once; learn the words.
        for (const row of this.database.prepare(`SELECT id, limited_visibility FROM upload_attempts
            WHERE limited_visibility LIKE '%is not allowed here%'`).all() as unknown as Array<{ id: string; limited_visibility: string }>) {
            const label = row.limited_visibility.replace(/Sorry, '[^'\n]+' is not allowed here\.?/g, "").trim();
            this.database.prepare("UPDATE upload_attempts SET limited_visibility = ? WHERE id = ?").run(label || null, row.id);
            this.recordProviderMessages(row.id, row.limited_visibility, new Date());
        }
        this.database.prepare(`
            INSERT OR IGNORE INTO production_version (id, version, activated_at)
            VALUES (1, ?, ?)
        `).run(
            isNewDatabase ? CURRENT_PRODUCTION_VERSION : "legacy-production-v1",
            new Date().toISOString(),
        );
    }

    close(): void { this.database.close(); }

    snapshotTo(destination: string): void {
        // A complete SQLite snapshot preserves descriptions, provenance and
        // metadata as well as the narrower retired upload ledger. VACUUM INTO
        // refuses an existing non-empty destination; it never overwrites one.
        this.database.prepare("VACUUM INTO ?").run(path.resolve(destination));
    }

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
        if (existing && existing.provider !== normalized.provider) {
            // The identical folder name exists under another provider: manual review.
            this.transaction(() => {
                this.database.prepare(`
                    UPDATE recordings SET state = 'blocked', block_reason = ?,
                        lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
                    WHERE id = ?
                `).run("identical folder name exists under another provider; manual review required",
                    timestamp, id);
                this.insertEvent(id, existing.state, "blocked", "cross-provider folder name collision", timestamp);
            });
        } else if (!existing) {
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
        } else if (existing && existing.sourceFingerprint !== normalized.sourceFingerprint) {
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
            antibot_failures: number;
            resume_at: string | null;
            trial_per_provider: number | null;
            trial_finished_at: string | null;
            upload_provider: ActiveUploadProvider;
            attention_reason: string | null;
            updated_at: string;
        } | undefined;
        if (!row) throw new Error("Campaign control row is missing");
        return {
            state: row.state,
            providerFilter: row.provider_filter,
            ordering: row.ordering,
            monthlyUploadLimitBytes: row.monthly_upload_limit_bytes,
            antibotFailures: row.antibot_failures,
            resumeAt: row.resume_at,
            trialPerProvider: row.trial_per_provider,
            trialFinishedAt: row.trial_finished_at,
            uploadProvider: row.upload_provider,
            attentionReason: row.attention_reason,
            updatedAt: row.updated_at,
        };
    }

    getProductionVersion(): string {
        const row = this.database.prepare("SELECT version FROM production_version WHERE id = 1")
            .get() as { version: string } | undefined;
        if (!row) throw new Error("Production version row is missing");
        return row.version;
    }

    listProductionRollovers(): Array<{
        fromVersion: string;
        toVersion: string;
        retiredRecordings: number;
        retiredRemoteUploads: number;
        preservedBandwidthBytes: number;
        createdAt: string;
    }> {
        const rows = this.database.prepare(`
            SELECT from_version, to_version, retired_recordings,
                retired_remote_uploads, preserved_bandwidth_bytes, created_at
            FROM production_rollovers ORDER BY id
        `).all() as unknown as Array<{
            from_version: string;
            to_version: string;
            retired_recordings: number;
            retired_remote_uploads: number;
            preserved_bandwidth_bytes: number;
            created_at: string;
        }>;
        return rows.map((row) => ({
            fromVersion: row.from_version,
            toVersion: row.to_version,
            retiredRecordings: row.retired_recordings,
            retiredRemoteUploads: row.retired_remote_uploads,
            preservedBandwidthBytes: row.preserved_bandwidth_bytes,
            createdAt: row.created_at,
        }));
    }

    planProductionRollover(targetVersion = CURRENT_PRODUCTION_VERSION): {
        required: boolean;
        fromVersion: string;
        toVersion: string;
        recordingCount: number;
        remoteUploadCount: number;
        leasedRecordingCount: number;
        activeUploadCount: number;
        preservedBandwidthBytes: number;
        ownedPaths: string[];
    } {
        if (!/^production-v\d+$/.test(targetVersion)) throw new Error("Invalid production version");
        const fromVersion = this.getProductionVersion();
        const recordingCount = this.database.prepare("SELECT COUNT(*) AS count FROM recordings")
            .get() as { count: number };
        const remoteUploadCount = this.database.prepare("SELECT COUNT(*) AS count FROM remote_uploads")
            .get() as { count: number };
        const leasedRecordingCount = this.database.prepare(`
            SELECT COUNT(*) AS count FROM recordings WHERE lease_owner IS NOT NULL
        `).get() as { count: number };
        const activeUploadCount = this.database.prepare(`
            SELECT COUNT(*) AS count FROM upload_attempts WHERE status = 'started'
        `).get() as { count: number };
        const bandwidth = this.database.prepare(`
            SELECT COALESCE(SUM(transmitted_bytes), 0) AS bytes FROM bandwidth_events
        `).get() as { bytes: number };
        const ownedRows = this.database.prepare(`
            SELECT path FROM artifacts
            UNION SELECT path FROM production_artifact_queue
            UNION SELECT path FROM artifact_variants
            UNION SELECT path FROM resolution_review_artifacts
            UNION SELECT path FROM remux_outputs
            UNION SELECT evidence_path AS path FROM descriptions
        `).all() as unknown as Array<{ path: string }>;
        return {
            required: fromVersion !== targetVersion,
            fromVersion,
            toVersion: targetVersion,
            recordingCount: recordingCount.count,
            remoteUploadCount: remoteUploadCount.count,
            leasedRecordingCount: leasedRecordingCount.count,
            activeUploadCount: activeUploadCount.count,
            preservedBandwidthBytes: bandwidth.bytes,
            ownedPaths: [...new Set(ownedRows.map((row) => path.resolve(row.path)))],
        };
    }

    commitProductionRollover(targetVersion = CURRENT_PRODUCTION_VERSION, now = new Date()): {
        rolledOver: boolean;
        fromVersion: string;
        toVersion: string;
        retiredRecordings: number;
        retiredRemoteUploads: number;
        preservedBandwidthBytes: number;
    } {
        const plan = this.planProductionRollover(targetVersion);
        if (!plan.required) return {
            rolledOver: false,
            fromVersion: plan.fromVersion,
            toVersion: plan.toVersion,
            retiredRecordings: 0,
            retiredRemoteUploads: 0,
            preservedBandwidthBytes: plan.preservedBandwidthBytes,
        };
        const control = this.getCampaignControl();
        if (control.state !== "paused") {
            throw new Error("Production rollover requires a paused campaign");
        }
        if (plan.leasedRecordingCount > 0 || plan.activeUploadCount > 0) {
            throw new Error(
                `Production rollover refuses ${plan.leasedRecordingCount} leased recording(s) `
                + `and ${plan.activeUploadCount} active upload(s)`,
            );
        }
        const timestamp = now.toISOString();
        this.transaction(() => {
            if (this.getProductionVersion() !== plan.fromVersion) {
                throw new Error("Production version changed while preparing rollover");
            }
            const currentLeases = this.database.prepare(`
                SELECT COUNT(*) AS count FROM recordings WHERE lease_owner IS NOT NULL
            `).get() as { count: number };
            const currentUploads = this.database.prepare(`
                SELECT COUNT(*) AS count FROM upload_attempts WHERE status = 'started'
            `).get() as { count: number };
            if (currentLeases.count > 0 || currentUploads.count > 0) {
                throw new Error("Production work became active while preparing rollover");
            }
            this.database.prepare(`
                INSERT INTO retired_recordings (
                    production_version, recording_id, provider, source_path, state,
                    block_reason, created_at, retired_at
                )
                SELECT ?, id, provider, source_path, state, block_reason, created_at, ?
                FROM recordings
            `).run(plan.fromVersion, timestamp);
            this.database.prepare(`
                INSERT INTO retired_upload_attempts (
                    production_version, attempt_id, recording_id, artifact_part,
                    status, phase, transmitted_bytes, remote_id, remote_url,
                    error, started_at, completed_at, retired_at
                )
                SELECT ?, id, recording_id, artifact_part, status, phase,
                    transmitted_bytes, remote_id, remote_url, error,
                    started_at, completed_at, ?
                FROM upload_attempts
            `).run(plan.fromVersion, timestamp);
            this.database.prepare(`
                INSERT INTO retired_remote_uploads (
                    production_version, recording_id, artifact_part, attempt_id,
                    remote_id, remote_url, verified_at, retired_at
                )
                SELECT ?, recording_id, artifact_part, attempt_id,
                    remote_id, remote_url, verified_at, ?
                FROM remote_uploads
            `).run(plan.fromVersion, timestamp);
            for (const table of [
                "upload_confirmations",
                "remote_uploads",
                "upload_attempts",
                "upload_reservations",
                "upload_metadata",
                "descriptions",
                "production_artifact_queue",
                "resolution_review_artifacts",
                "artifact_variants",
                "remux_outputs",
                "artifacts",
                "manual_pieces",
                "recording_provenance",
                "state_events",
            ]) {
                this.database.exec(`DELETE FROM ${table}`);
            }
            this.database.exec("DELETE FROM recordings");
            this.database.exec("DELETE FROM campaign_trial_recordings");
            this.database.exec("DELETE FROM comparison_trial");
            this.database.exec("DELETE FROM worker_heartbeat");
            this.database.prepare(`
                INSERT INTO production_rollovers (
                    from_version, to_version, retired_recordings, retired_remote_uploads,
                    preserved_bandwidth_bytes, created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
            `).run(
                plan.fromVersion,
                plan.toVersion,
                plan.recordingCount,
                plan.remoteUploadCount,
                plan.preservedBandwidthBytes,
                timestamp,
            );
            this.database.prepare(`
                UPDATE production_version SET version = ?, activated_at = ? WHERE id = 1
            `).run(plan.toVersion, timestamp);
        });
        return {
            rolledOver: true,
            fromVersion: plan.fromVersion,
            toVersion: plan.toVersion,
            retiredRecordings: plan.recordingCount,
            retiredRemoteUploads: plan.remoteUploadCount,
            preservedBandwidthBytes: plan.preservedBandwidthBytes,
        };
    }

    configureCampaign(
        providerFilter: CampaignProviderFilter,
        monthlyUploadLimitBytes: number,
        now = new Date(),
        trialPerProvider?: number | null,
    ): CampaignControl {
        if (!["all", "tango", "fc2", "sc"].includes(providerFilter)) {
            throw new Error("Campaign provider must be all, tango, fc2, or sc");
        }
        if (this.getComparisonTrial() && (providerFilter !== "all" || (trialPerProvider !== undefined && trialPerProvider !== null))) {
            throw new Error("The comparison queue is controlled by selected paths, not provider quotas");
        }
        if (!Number.isSafeInteger(monthlyUploadLimitBytes) || monthlyUploadLimitBytes <= 0) {
            throw new Error("Campaign monthly upload limit must be a positive integer");
        }
        if (trialPerProvider !== undefined) {
            if (trialPerProvider !== null && (!Number.isSafeInteger(trialPerProvider) || trialPerProvider <= 0)) {
                throw new Error("Trial recordings per provider must be a positive integer or none");
            }
            if (this.getCampaignControl().state !== "paused") throw new Error("Pause the campaign before changing its trial limit");
            const active = this.database.prepare(`SELECT
                (SELECT COUNT(*) FROM recordings WHERE lease_owner IS NOT NULL)
                + (SELECT COUNT(*) FROM upload_attempts WHERE status = 'started') AS count`).get() as { count: number };
            if (active.count > 0) throw new Error("Wait for in-flight work to finish before changing the trial limit");
            const control = this.getCampaignControl();
            if (trialPerProvider !== null && control.trialPerProvider !== null && control.trialFinishedAt === null
                && this.getCampaignTrialProgress().some((progress) => progress.admitted > trialPerProvider)) {
                throw new Error("Trial limit cannot be lower than the number already admitted");
            }
        }
        if ((trialPerProvider === undefined ? this.getCampaignControl().trialPerProvider : trialPerProvider) !== null
            && providerFilter !== "all") throw new Error("A per-provider trial requires --provider all");
        return this.transaction(() => {
            if (trialPerProvider !== undefined) {
                const control = this.getCampaignControl();
                if (trialPerProvider === null || control.trialPerProvider === null || control.trialFinishedAt !== null) {
                    this.database.exec("DELETE FROM campaign_trial_recordings");
                }
                this.database.prepare("UPDATE campaign_control SET trial_per_provider = ?, trial_finished_at = NULL, resume_at = NULL WHERE id = 1")
                    .run(trialPerProvider);
            }
            this.database.prepare(`
                UPDATE campaign_control SET provider_filter = ?, ordering = 'oldest',
                    monthly_upload_limit_bytes = ?, updated_at = ? WHERE id = 1
            `).run(providerFilter, monthlyUploadLimitBytes, now.toISOString());
            return this.getCampaignControl();
        });
    }

    getCampaignTrialProgress(): Array<{ provider: string; admitted: number; recordings: Array<{ id: string; state: string }> }> {
        const rows = this.database.prepare(`
            SELECT t.recording_id AS id, t.provider, COALESCE(r.state, 'source_missing') AS state
            FROM campaign_trial_recordings t LEFT JOIN recordings r ON r.id = t.recording_id
            ORDER BY t.admitted_at, t.recording_id
        `).all() as unknown as Array<{ id: string; provider: string; state: string }>;
        return ["tango", "fc2", "sc"].map((provider) => ({
            provider,
            admitted: rows.filter((row) => row.provider === provider).length,
            recordings: rows.filter((row) => row.provider === provider).map(({ id, state }) => ({ id, state })),
        }));
    }

    campaignTrialAllows(provider: string, recordingId?: string): boolean {
        const control = this.getCampaignControl();
        if (control.trialPerProvider === null) return true;
        if (control.trialFinishedAt !== null) return false;
        if (recordingId && this.database.prepare("SELECT 1 FROM campaign_trial_recordings WHERE recording_id = ?")
            .get(recordingId)) return true;
        const row = this.database.prepare("SELECT COUNT(*) AS count FROM campaign_trial_recordings WHERE provider = ?")
            .get(provider) as { count: number };
        return row.count < control.trialPerProvider;
    }

    enrollCampaignTrial(recording: Recording, now = new Date()): void {
        this.transaction(() => {
            if (!this.campaignTrialAllows(recording.provider, recording.id)) throw new Error("Campaign trial provider limit reached");
            if (this.getCampaignControl().trialPerProvider === null) return;
            this.database.prepare("INSERT OR IGNORE INTO campaign_trial_recordings VALUES (?, ?, ?)")
                .run(recording.id, recording.provider, now.toISOString());
        });
    }

    finishCampaignTrial(now = new Date()): void {
        this.database.prepare(`UPDATE campaign_control SET state = 'paused', resume_at = NULL,
            trial_finished_at = ?, updated_at = ? WHERE id = 1 AND trial_per_provider IS NOT NULL`)
            .run(now.toISOString(), now.toISOString());
    }

    getComparisonTrial(): { selection: RecordingInput[]; fileErrors: string[]; lockedAt: string | null; completedAt: string | null } | null {
        const row = this.database.prepare("SELECT * FROM comparison_trial WHERE id = 1").get() as
            { selection_json: string; selection_errors_json: string; locked_at: string | null; completed_at: string | null } | undefined;
        return row ? { selection: JSON.parse(row.selection_json) as RecordingInput[], fileErrors: JSON.parse(row.selection_errors_json) as string[], lockedAt: row.locked_at, completedAt: row.completed_at } : null;
    }

    prepareComparisonTrial(): void {
        if (this.getCampaignControl().state !== "paused") throw new Error("Comparison preparation requires a paused campaign");
        this.database.exec("INSERT OR IGNORE INTO comparison_trial (id, selection_json) VALUES (1, '[]')");
        this.database.exec("UPDATE campaign_control SET provider_filter = 'all', trial_per_provider = NULL, trial_finished_at = NULL, resume_at = NULL WHERE id = 1");
    }

    appendComparisonSelection(selection: readonly RecordingInput[]): void {
        this.transaction(() => {
            const trial = this.getComparisonTrial();
            if (!trial) throw new Error("Prepare the comparison trial first");
            const merged = [...trial.selection];
            for (const recording of selection) {
                if (merged.some((existing) => existing.sourcePath === recording.sourcePath)) continue;
                if (merged.some((existing) => path.basename(existing.sourcePath) === path.basename(recording.sourcePath))) {
                    throw new Error(`Recording name collision in comparison queue: ${recording.sourcePath}`);
                }
                merged.push(recording);
            }
            if (merged.length !== trial.selection.length) this.database.prepare("UPDATE comparison_trial SET selection_json = ?, completed_at = NULL WHERE id = 1").run(JSON.stringify(merged));
        });
    }

    syncComparisonQueue(requested: readonly RecordingInput[]): { added: number; removed: number } {
        let result = { added: 0, removed: 0 };
        this.transaction(() => {
            const trial = this.getComparisonTrial();
            if (!trial) throw new Error("Prepare the comparison trial first");
            // Admission/provenance alone is still queued. Once a local stage
            // has been claimed, removal must not cancel work or erase evidence.
            const protectedEntries = trial.selection.filter((source) => {
                const row = this.getBySourcePath(source.sourcePath);
                return row && (row.state !== "server_ready" || row.attemptCount > 0
                    || row.leaseOwner !== null || this.getRemuxOutput(row.id) !== null);
            });
            const next = [...protectedEntries];
            for (const source of requested) {
                if (next.some((entry) => entry.sourcePath === source.sourcePath)) continue;
                const existingRow = this.get(path.basename(source.sourcePath));
                if (next.some((entry) => path.basename(entry.sourcePath) === path.basename(source.sourcePath))
                    || (existingRow && existingRow.sourcePath !== source.sourcePath)) {
                    throw new Error(`Recording name collision in comparison queue: ${source.sourcePath}`);
                }
                next.push(source);
            }
            result = {
                added: next.filter((entry) => !trial.selection.some((old) => old.sourcePath === entry.sourcePath)).length,
                removed: trial.selection.filter((old) => !next.some((entry) => old.sourcePath === entry.sourcePath)).length,
            };
            if (JSON.stringify(next) !== JSON.stringify(trial.selection)) {
                this.database.prepare("UPDATE comparison_trial SET selection_json = ?, completed_at = NULL WHERE id = 1")
                    .run(JSON.stringify(next));
            }
        });
        return result;
    }

    setComparisonFileErrors(errors: readonly string[]): void {
        this.database.prepare("UPDATE comparison_trial SET selection_errors_json = ? WHERE id = 1").run(JSON.stringify(errors));
    }

    comparisonAllows(recording: RecordingInput): boolean {
        const trial = this.getComparisonTrial();
        return trial !== null && trial.selection.some((item) => item.sourcePath === recording.sourcePath
            && item.provider === recording.provider && item.sourceFingerprint === recording.sourceFingerprint);
    }

    finishComparisonTrial(expectedCount: number, now = new Date()): void {
        this.transaction(() => {
            // The file watcher may append while the worker checks artifacts.
            if (this.getComparisonTrial()?.selection.length !== expectedCount) return;
            this.database.prepare("UPDATE comparison_trial SET completed_at = COALESCE(completed_at, ?) WHERE id = 1").run(now.toISOString());
        });
    }

    comparisonPolicyReason(id: string): string | null {
        const row = this.database.prepare("SELECT reason FROM state_events WHERE recording_id = ? AND reason LIKE 'resolution-policy-%' ORDER BY id DESC LIMIT 1")
            .get(id) as { reason: string } | undefined;
        return row?.reason ?? null;
    }

    setCampaignState(state: CampaignControl["state"], now = new Date()): CampaignControl {
        if (state !== "paused" && state !== "running") throw new Error("Campaign state must be paused or running");
        const trial = this.getComparisonTrial();
        if (state === "running" && trial) {
            this.database.prepare("UPDATE comparison_trial SET locked_at = COALESCE(locked_at, ?) WHERE id = 1").run(now.toISOString());
        }
        // A manual pause is indefinite; a manual resume starts a fresh streak.
        if (state === "paused") {
            this.database.prepare("UPDATE campaign_control SET state = 'paused', resume_at = NULL, updated_at = ? WHERE id = 1")
                .run(now.toISOString());
        } else {
            this.database.prepare(`UPDATE campaign_control SET state = 'running', resume_at = NULL, antibot_failures = 0, attention_reason = NULL,
                trial_per_provider = CASE WHEN trial_finished_at IS NOT NULL THEN NULL ELSE trial_per_provider END,
                trial_finished_at = NULL, updated_at = ? WHERE id = 1`)
                .run(now.toISOString());
        }
        return this.getCampaignControl();
    }

    recordAntibotFailure(streak: number, waitMilliseconds: number, now = new Date()): CampaignControl {
        const timestamp = now.toISOString();
        const resumeAt = new Date(now.getTime() + waitMilliseconds).toISOString();
        this.database.prepare(`
            UPDATE campaign_control SET state = 'paused', resume_at = ?, antibot_failures = ?, updated_at = ?
            WHERE id = 1
        `).run(resumeAt, streak, timestamp);
        return this.getCampaignControl();
    }

    recordUploadLimitCooldown(now = new Date()): CampaignControl {
        const timestamp = now.toISOString();
        const resumeAt = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
        this.database.prepare(`
            UPDATE campaign_control SET state = 'paused', resume_at = ?, antibot_failures = 0, updated_at = ?
            WHERE id = 1
        `).run(resumeAt, timestamp);
        return this.getCampaignControl();
    }

    resumeFromCooldown(now = new Date()): CampaignControl {
        const timestamp = now.toISOString();
        this.database.prepare(`
            UPDATE campaign_control SET state = 'running', resume_at = NULL, updated_at = ?
            WHERE id = 1 AND resume_at IS NOT NULL AND resume_at <= ?
        `).run(timestamp, timestamp);
        return this.getCampaignControl();
    }

    resetAntibotFailures(now = new Date()): CampaignControl {
        this.database.prepare("UPDATE campaign_control SET antibot_failures = 0, updated_at = ? WHERE id = 1")
            .run(now.toISOString());
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

    writeWorkerHeartbeat(now = new Date()): void {
        this.database.prepare(`
            INSERT INTO worker_heartbeat (id, updated_at) VALUES (1, ?)
            ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
        `).run(now.toISOString());
    }

    campaignIsActive(now = new Date(), staleAfterMilliseconds = 90_000): boolean {
        const row = this.database.prepare("SELECT updated_at FROM worker_heartbeat WHERE id = 1")
            .get() as { updated_at: string } | undefined;
        if (!row) return false;
        const heartbeat = Date.parse(row.updated_at);
        return Number.isFinite(heartbeat) && now.getTime() - heartbeat < staleAfterMilliseconds;
    }

    releaseAllLeases(now = new Date()): number {
        const result = this.database.prepare(`
            UPDATE recordings SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
            WHERE lease_owner IS NOT NULL
        `).run(now.toISOString());
        return Number(result.changes);
    }

    retryBlocked(id: string, now = new Date()): Recording {
        const timestamp = now.toISOString();
        this.transaction(() => {
            const lastBlock = this.database.prepare(`
                SELECT from_state FROM state_events
                WHERE recording_id = ? AND to_state = 'blocked'
                ORDER BY id DESC LIMIT 1
            `).get(id) as { from_state: PipelineState | null } | undefined;
            const retryState = lastBlock?.from_state;
            if (!retryState || ![
                "server_ready", "remuxed", "artifact_valid", "described", "metadata_ready",
            ].includes(retryState)) {
                throw new Error(`Recording ${id} has no unblockable blocked state`);
            }
            this.updateStateInTransaction(id, "blocked", retryState, "manual unblock requested", timestamp);
        });
        return this.requireRecording(id);
    }

    hasResolutionPolicyAssessment(id: string, version: string): boolean {
        const row = this.database.prepare(`
            SELECT 1 AS present FROM state_events
            WHERE recording_id = ? AND reason LIKE ?
            LIMIT 1
        `).get(id, `${version}:%`) as { present: number } | undefined;
        return row?.present === 1;
    }

    recordResolutionPolicyAssessment(id: string, reason: string, now = new Date()): Recording {
        const recording = this.requireRecording(id);
        this.insertEvent(id, recording.state, recording.state, reason, now.toISOString());
        return recording;
    }

    resetLocalWorkForResolutionPolicy(
        id: string,
        reason: string,
        now = new Date(),
    ): { recording: Recording; obsoletePaths: string[] } {
        const recording = this.requireRecording(id);
        if (!["remuxed", "artifact_valid", "described", "metadata_ready"].includes(recording.state)) {
            throw new Error(`Recording ${id} cannot be reset from ${recording.state}`);
        }
        const obsoletePaths = [...new Set([
            this.getRemuxOutput(id),
            this.getArtifact(id)?.path ?? null,
            ...this.listQueuedProductionArtifacts(id).map((artifact) => artifact.path),
            ...this.listResolutionReviewArtifacts(id).map((artifact) => artifact.path),
        ].filter((candidate): candidate is string => candidate !== null))];
        const timestamp = now.toISOString();
        this.transaction(() => {
            for (const table of [
                "upload_metadata",
                "descriptions",
                "production_artifact_queue",
                "resolution_review_artifacts",
                "artifacts",
                "remux_outputs",
                "manual_pieces",
            ]) {
                this.database.prepare(`DELETE FROM ${table} WHERE recording_id = ?`).run(id);
            }
            const reset = this.database.prepare(`
                UPDATE recordings SET state = 'server_ready', block_reason = NULL,
                    lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
                WHERE id = ? AND state = ?
            `).run(timestamp, id, recording.state);
            if (reset.changes !== 1) throw new Error(`Recording ${id} changed while applying resolution policy`);
            this.insertEvent(id, recording.state, "server_ready", reason, timestamp);
        });
        return { recording: this.requireRecording(id), obsoletePaths };
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
                INSERT INTO artifacts (recording_id, part, path, size_bytes, sha256, validated_at)
                VALUES (?, 'full', ?, ?, ?, ?)
                ON CONFLICT(recording_id) DO UPDATE SET path = excluded.path,
                    part = excluded.part,
                    size_bytes = excluded.size_bytes, sha256 = excluded.sha256,
                    validated_at = excluded.validated_at
            `).run(id, path.resolve(artifact.path), artifact.sizeBytes, artifact.sha256, artifact.validatedAt);
            this.updateStateInTransaction(id, "remuxed", "artifact_valid", "artifact hash and validation persisted", timestamp);
        });
        return this.requireRecording(id);
    }

    getArtifact(id: string): ArtifactRecord | null {
        const row = this.database.prepare("SELECT * FROM artifacts WHERE recording_id = ?").get(id) as ProductionArtifactRow | undefined;
        return row ? mapArtifact(row) : null;
    }

    getArtifactPart(id: string): ProductionArtifactPart | null {
        const row = this.database.prepare("SELECT part FROM artifacts WHERE recording_id = ?").get(id) as {
            part: ProductionArtifactPart;
        } | undefined;
        return row?.part ?? null;
    }

    saveProductionArtifactSet(
        id: string,
        primary: Omit<QueuedProductionArtifactRecord, "recordingId"> | (Omit<ArtifactRecord, "recordingId"> & {
            part: ProductionArtifactPart;
            segmentCount: number;
            sourceDimensions: readonly string[];
        }),
        queued: readonly (Omit<ArtifactRecord, "recordingId"> & {
            part: Exclude<ProductionArtifactPart, "full">;
            segmentCount: number;
            sourceDimensions: readonly string[];
        })[],
        reason: string,
        now = new Date(),
    ): Recording {
        const recording = this.requireRecording(id);
        if (recording.state !== "server_ready") throw new Error(`Recording ${id} is not server_ready`);
        if (primary.part === "full") throw new Error("An automatic artifact set requires a split primary part");
        const all = [primary, ...queued];
        const parts = new Set<ProductionArtifactPart>();
        for (const artifact of all) {
            if (parts.has(artifact.part)) throw new Error(`Duplicate production artifact part ${artifact.part}`);
            parts.add(artifact.part);
            if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0
                || !/^[a-f0-9]{64}$/.test(artifact.sha256)
                || !Number.isSafeInteger(artifact.segmentCount) || artifact.segmentCount <= 0
                || artifact.sourceDimensions.length === 0) {
                throw new Error("Production artifact metadata is invalid");
            }
        }
        const timestamp = now.toISOString();
        this.transaction(() => {
            this.database.prepare("DELETE FROM production_artifact_queue WHERE recording_id = ?").run(id);
            this.database.prepare(`
                INSERT INTO artifacts (recording_id, part, path, size_bytes, sha256, validated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(recording_id) DO UPDATE SET
                    part = excluded.part, path = excluded.path, size_bytes = excluded.size_bytes,
                    sha256 = excluded.sha256, validated_at = excluded.validated_at
            `).run(id, primary.part, path.resolve(primary.path), primary.sizeBytes, primary.sha256, primary.validatedAt);
            const insert = this.database.prepare(`
                INSERT INTO production_artifact_queue (
                    recording_id, part, queue_position, path, size_bytes, sha256,
                    segment_count, source_dimensions_json, validated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            queued.forEach((artifact, index) => insert.run(
                id, artifact.part, index, path.resolve(artifact.path), artifact.sizeBytes, artifact.sha256,
                artifact.segmentCount, JSON.stringify(artifact.sourceDimensions), artifact.validatedAt,
            ));
            this.updateStateInTransaction(id, "server_ready", "artifact_valid", reason, timestamp);
        });
        return this.requireRecording(id);
    }

    listQueuedProductionArtifacts(id: string): QueuedProductionArtifactRecord[] {
        const rows = this.database.prepare(`
            SELECT * FROM production_artifact_queue WHERE recording_id = ? ORDER BY queue_position
        `).all(id) as unknown as QueuedProductionArtifactRow[];
        return rows.map(mapQueuedProductionArtifact);
    }

    saveArtifactVariant(
        id: string,
        variant: ArtifactVariant,
        artifact: Omit<ArtifactRecord, "recordingId">,
        sourceFrameCount: number,
        droppedSourceFrames: number,
    ): ArtifactVariantRecord {
        this.requireRecording(id);
        if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0
            || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
            throw new Error("Artifact variant requires a positive integer size and lowercase SHA-256");
        }
        if (!Number.isSafeInteger(sourceFrameCount) || sourceFrameCount <= 0
            || !Number.isSafeInteger(droppedSourceFrames) || droppedSourceFrames < 0
            || droppedSourceFrames >= sourceFrameCount) {
            throw new Error("Artifact variant requires valid source and dropped frame counts");
        }
        this.database.prepare(`
            INSERT INTO artifact_variants (
                recording_id, variant, path, size_bytes, sha256,
                source_frame_count, dropped_source_frames, validated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(recording_id, variant) DO UPDATE SET
                path = excluded.path,
                size_bytes = excluded.size_bytes,
                sha256 = excluded.sha256,
                source_frame_count = excluded.source_frame_count,
                dropped_source_frames = excluded.dropped_source_frames,
                validated_at = excluded.validated_at
        `).run(
            id,
            variant,
            path.resolve(artifact.path),
            artifact.sizeBytes,
            artifact.sha256,
            sourceFrameCount,
            droppedSourceFrames,
            artifact.validatedAt,
        );
        const saved = this.getArtifactVariant(id, variant);
        if (!saved) throw new Error(`Failed to save ${variant} artifact for ${id}`);
        return saved;
    }

    getArtifactVariant(id: string, variant: ArtifactVariant): ArtifactVariantRecord | null {
        const row = this.database.prepare(`
            SELECT * FROM artifact_variants WHERE recording_id = ? AND variant = ?
        `).get(id, variant) as ArtifactVariantRow | undefined;
        return row ? mapArtifactVariant(row) : null;
    }

    listArtifactVariants(id: string): ArtifactVariantRecord[] {
        const rows = this.database.prepare(`
            SELECT * FROM artifact_variants WHERE recording_id = ? ORDER BY variant
        `).all(id) as unknown as ArtifactVariantRow[];
        return rows.map(mapArtifactVariant);
    }

    saveResolutionReviewAndBlock(
        id: string,
        artifacts: readonly Omit<ResolutionReviewArtifactRecord, "recordingId">[],
        reason: string,
        now = new Date(),
    ): Recording {
        const recording = this.requireRecording(id);
        if (recording.state !== "server_ready") throw new Error(`Recording ${id} is not ready for resolution review`);
        const parts = new Set<ResolutionReviewPart>();
        for (const artifact of artifacts) {
            if (parts.has(artifact.part)) throw new Error(`Duplicate resolution-review part ${artifact.part}`);
            parts.add(artifact.part);
            if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0
                || !/^[a-f0-9]{64}$/.test(artifact.sha256)
                || !Number.isSafeInteger(artifact.segmentCount) || artifact.segmentCount <= 0
                || artifact.sourceDimensions.length === 0) {
                throw new Error("Resolution-review artifact metadata is invalid");
            }
        }
        const timestamp = now.toISOString();
        this.transaction(() => {
            this.database.prepare("DELETE FROM resolution_review_artifacts WHERE recording_id = ?").run(id);
            const insert = this.database.prepare(`
                INSERT INTO resolution_review_artifacts (
                    recording_id, part, path, size_bytes, sha256,
                    segment_count, source_dimensions_json, validated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const artifact of artifacts) {
                insert.run(
                    id,
                    artifact.part,
                    path.resolve(artifact.path),
                    artifact.sizeBytes,
                    artifact.sha256,
                    artifact.segmentCount,
                    JSON.stringify(artifact.sourceDimensions),
                    artifact.validatedAt,
                );
            }
            assertTransition("server_ready", "blocked");
            const blocked = this.database.prepare(`
                UPDATE recordings SET state = 'blocked', block_reason = ?, updated_at = ?
                WHERE id = ? AND state = 'server_ready'
            `).run(reason, timestamp, id);
            if (blocked.changes !== 1) throw new Error(`Recording ${id} is not in expected state server_ready`);
            this.insertEvent(id, "server_ready", "blocked", reason, timestamp);
        });
        return this.requireRecording(id);
    }

    listResolutionReviewArtifacts(id: string): ResolutionReviewArtifactRecord[] {
        const rows = this.database.prepare(`
            SELECT * FROM resolution_review_artifacts WHERE recording_id = ? ORDER BY part
        `).all(id) as unknown as ResolutionReviewArtifactRow[];
        return rows.map(mapResolutionReviewArtifact);
    }

    saveRemuxOutput(
        id: string,
        outputPath: string,
        now = new Date(),
        eventReason = "stream-copy artifact published",
    ): Recording {
        const timestamp = now.toISOString();
        this.transaction(() => {
            this.database.prepare(`
                INSERT INTO remux_outputs (recording_id, path, created_at)
                VALUES (?, ?, ?)
                ON CONFLICT(recording_id) DO UPDATE SET path = excluded.path, created_at = excluded.created_at
            `).run(id, path.resolve(outputPath), timestamp);
            this.updateStateInTransaction(id, "server_ready", "remuxed", eventReason, timestamp);
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
    }, now = new Date()): Recording {
        const recording = this.requireRecording(id);
        const provenance = this.getProvenance(id);
        if (recording.state !== "described") throw new Error(`Recording ${id} is not described`);
        if (!allowsUpload(provenance)) {
            throw new Error(`Recording ${id} has unresolved provenance`);
        }
        if (!metadata.title || metadata.title.length > 255) throw new Error("Upload title must contain at most 255 characters");
        if (!metadata.description || metadata.description.length > 1_000) {
            throw new Error("Upload description must contain at most 1000 characters");
        }
        if (metadata.tags.length > 20 || metadata.tags.some((tag) => !tag.trim())) {
            throw new Error("Upload metadata allows at most twenty nonempty tags");
        }
        const timestamp = now.toISOString();
        this.transaction(() => {
            this.database.prepare(`
                INSERT INTO upload_metadata (
                    recording_id, title, description, tags_json, created_at
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(recording_id) DO UPDATE SET
                    title = excluded.title,
                    description = excluded.description,
                    tags_json = excluded.tags_json,
                    created_at = excluded.created_at
            `).run(id, metadata.title, metadata.description,
                JSON.stringify(metadata.tags), timestamp);
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
            createdAt: row.created_at,
        };
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

    reserveUpload(id: string, bytes: number, now = new Date(), timeZone = "Europe/Tirane", limit = DEFAULT_MONTHLY_UPLOAD_LIMIT_BYTES, provider: ActiveUploadProvider = "xvideos"): string {
        assertUploadProvider(provider);
        if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("Upload reservation bytes must be a positive integer");
        const month = calendarMonth(now, timeZone);
        const timestamp = now.toISOString();
        const reservationId = randomUUID();
        this.transaction(() => {
            const recording = this.requireRecording(id);
            if (recording.state !== "metadata_ready") throw new Error(`Recording ${id} has no upload-ready metadata`);
            if (this.getUploadIdentity(id) || this.database.prepare(`SELECT 1 FROM upload_confirmations
                WHERE recording_id = ? AND status = 'pending' LIMIT 1`).get(id)) {
                throw new Error("Recording already has a remote upload or unresolved acceptance; refusing another destination");
            }
            if (!this.canAttemptUpload(id, now)) throw new Error("Weekly upload retry deadline has not elapsed");
            const artifactPart = this.getArtifactPart(id);
            if (!artifactPart) throw new Error(`Recording ${id} has no production artifact part`);
            const usage = this.uploadUsage(month);
            if (usage.spent + usage.reserved + bytes > limit) throw new Error(`Monthly upload limit exceeded for ${month}`);
            this.database.prepare(`
                INSERT INTO upload_reservations (
                    id, recording_id, artifact_part, provider, calendar_month, reserved_bytes,
                    status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)
            `).run(reservationId, id, artifactPart, provider, month, bytes, timestamp, timestamp);
            this.updateStateInTransaction(id, "metadata_ready", "xvideos_admitted", "monthly bytes reserved", timestamp);
        });
        return reservationId;
    }

    beginUpload(id: string, reservationId: string, now = new Date(), provider: ActiveUploadProvider = "xvideos"): string {
        assertUploadProvider(provider);
        const attemptId = randomUUID();
        const timestamp = now.toISOString();
        this.transaction(() => {
            const reservation = this.database.prepare(`
                SELECT id, artifact_part, provider FROM upload_reservations
                WHERE id = ? AND recording_id = ? AND status = 'reserved'
            `).get(reservationId, id) as { id: string; artifact_part: ProductionArtifactPart; provider: string } | undefined;
            if (!reservation) throw new Error(`No active reservation ${reservationId} for ${id}`);
            if (reservation.provider !== provider) throw new Error("Uploader destination does not match the durable reservation");
            if (reservation.artifact_part !== this.getArtifactPart(id)) {
                throw new Error(`Upload reservation ${reservationId} does not match the current artifact part`);
            }
            this.database.prepare(`
                INSERT INTO upload_attempts (
                    id, reservation_id, recording_id, artifact_part, provider, status, started_at, retry_not_before
                ) VALUES (?, ?, ?, ?, ?, 'started', ?, ?)
            `).run(attemptId, reservationId, id, reservation.artifact_part, reservation.provider, timestamp,
                new Date(now.getTime() + UPLOAD_RETRY_MILLISECONDS).toISOString());
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
            SELECT phase, progress_bytes, transfer_started FROM upload_attempts WHERE id = ? AND status = 'started'
        `).get(attemptId) as { phase: keyof typeof order; progress_bytes: number; transfer_started: number } | undefined;
        if (!row) throw new Error(`Upload attempt ${attemptId} is not active`);
        if (order[phase] < order[row.phase] || transmittedBytes < row.progress_bytes) {
            throw new Error("Upload progress cannot move backwards");
        }
        // Keep the persisted phase at `started` while bytes are in flight. Older
        // schema-v3 databases enforce the original three-value CHECK constraint;
        // A separate durable flag records the transfer boundary even with zero
        // bytes, without rebuilding historical tables to change that CHECK.
        const persistedPhase = phase === "file_uploading" ? "started" : phase;
        this.database.prepare(`
            UPDATE upload_attempts SET phase = ?, progress_bytes = ?, transfer_started = 1 WHERE id = ?
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
            SELECT phase, progress_bytes, transfer_started FROM upload_attempts WHERE id = ? AND status = 'started'
        `).get(attemptId) as {
            phase: "started" | "file_uploading" | "file_uploaded" | "metadata_submitting";
            progress_bytes: number;
            transfer_started: number;
        } | undefined;
        if (!row) throw new Error(`Upload attempt ${attemptId} is not active`);
        return { phase: row.phase === "started" && row.transfer_started ? "file_uploading" : row.phase,
            transmittedBytes: row.progress_bytes };
    }

    recoverInterruptedUploads(now = new Date()): Array<{ recordingId: string; disposition: string }> {
        const timestamp = now.toISOString();
        // No attempt means no network operation was invoked after reservation.
        this.transaction(() => {
            const rows = this.database.prepare(`SELECT u.id, u.recording_id FROM upload_reservations u
                JOIN recordings r ON r.id = u.recording_id WHERE u.status = 'reserved' AND r.state = 'xvideos_admitted'
                AND NOT EXISTS (SELECT 1 FROM upload_attempts a WHERE a.reservation_id = u.id)`)
                .all() as unknown as Array<{ id: string; recording_id: string }>;
            for (const row of rows) {
                this.database.prepare(`UPDATE upload_reservations SET status = 'released', updated_at = ? WHERE id = ?`).run(timestamp, row.id);
                this.updateStateInTransaction(row.recording_id, "xvideos_admitted", "metadata_ready", "restart released unused upload reservation", timestamp);
            }
        });
        const attempts = this.database.prepare(`
            SELECT a.id, a.provider, a.recording_id, a.reservation_id, a.phase, a.progress_bytes, a.transfer_started,
                r.calendar_month
            FROM upload_attempts a
            JOIN upload_reservations r ON r.id = a.reservation_id
            JOIN recordings rec ON rec.id = a.recording_id
            WHERE a.status = 'started' AND rec.state = 'xvideos_uploading'
            ORDER BY a.started_at, a.id
        `).all() as unknown as Array<{
            id: string;
            provider: string;
            recording_id: string;
            reservation_id: string;
            phase: "started" | "file_uploading" | "file_uploaded" | "metadata_submitting";
            progress_bytes: number;
            transfer_started: number;
            calendar_month: string;
        }>;
        const results: Array<{ recordingId: string; disposition: string }> = [];
        for (const attempt of attempts) {
            this.transaction(() => {
                const uncertain = !!attempt.transfer_started || attempt.phase !== "started" || attempt.progress_bytes > 0;
                if (attempt.progress_bytes > 0) {
                    this.database.prepare(`
                        INSERT INTO bandwidth_events (
                            recording_id, attempt_id, provider, calendar_month,
                            transmitted_bytes, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?)
                    `).run(attempt.recording_id, attempt.id, attempt.provider, attempt.calendar_month,
                        attempt.progress_bytes, timestamp);
                }
                this.database.prepare(`
                    UPDATE upload_attempts SET status = ?, transmitted_bytes = ?, error = ?, completed_at = ?
                    WHERE id = ? AND status = 'started'
                `).run(uncertain ? "uncertain" : "failed", attempt.progress_bytes,
                    `process interrupted during ${attempt.phase === "started" && attempt.transfer_started ? "file_uploading" : attempt.phase}`, timestamp, attempt.id);
                this.database.prepare(`
                    UPDATE upload_reservations SET status = 'released', updated_at = ? WHERE id = ?
                `).run(timestamp, attempt.reservation_id);
                if (uncertain) {
                    this.database.prepare(`
                        INSERT INTO upload_confirmations (
                            attempt_id, recording_id, confirm_after, status, checked_at
                        ) VALUES (?, ?, ?, 'pending', NULL)
                    `).run(attempt.id, attempt.recording_id,
                        new Date(now.getTime() + 24 * 60 * 60_000).toISOString());
                    this.updateStateInTransaction(attempt.recording_id, "xvideos_uploading", "xvideos_uncertain",
                        "interrupted after upload may have started; acceptance requires confirmation", timestamp);
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
        confirmation?: { confirmAfter: Date };
    }, now = new Date()): Recording {
        if (!Number.isSafeInteger(outcome.transmittedBytes) || outcome.transmittedBytes < 0) {
            throw new Error("transmittedBytes must be a nonnegative integer");
        }
        const timestamp = now.toISOString();
        let recordingId = "";
        this.transaction(() => {
            const attempt = this.database.prepare(`
                SELECT a.recording_id, a.provider, a.reservation_id, a.progress_bytes,
                    r.reserved_bytes, r.calendar_month
                FROM upload_attempts a JOIN upload_reservations r ON r.id = a.reservation_id
                WHERE a.id = ? AND a.status = 'started'
            `).get(attemptId) as {
                recording_id: string;
                provider: string;
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
                UPDATE upload_attempts SET status = ?, transmitted_bytes = ?, remote_id = COALESCE(?, remote_id),
                    remote_url = ?, error = ?, completed_at = ? WHERE id = ?
            `).run(outcome.status, outcome.transmittedBytes, outcome.remoteId ?? null,
                outcome.remoteUrl ?? null, outcome.error ?? null, timestamp, attemptId);
            this.database.prepare(`
                INSERT INTO bandwidth_events (
                    recording_id, attempt_id, provider, calendar_month,
                    transmitted_bytes, created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
            `).run(recordingId, attemptId, attempt.provider, attempt.calendar_month, outcome.transmittedBytes, timestamp);
            this.database.prepare(`
                UPDATE upload_reservations SET status = ?, updated_at = ? WHERE id = ?
            `).run(outcome.status === "accepted" ? "consumed" : "released", timestamp, attempt.reservation_id);
            if (outcome.status === "uncertain" && outcome.confirmation) {
                this.database.prepare(`
                    INSERT INTO upload_confirmations (
                        attempt_id, recording_id, confirm_after, status, checked_at
                    ) VALUES (?, ?, ?, 'pending', NULL)
                `).run(attemptId, recordingId,
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

    getUploadIdentity(id: string): { remoteId: string; remoteUrl: string | null; verified: boolean } | null {
        const artifactPart = this.getArtifactPart(id) ?? "full";
        const verified = this.database.prepare(`
            SELECT remote_id, remote_url FROM remote_uploads
            WHERE recording_id = ? AND artifact_part = ? ORDER BY verified_at DESC LIMIT 1
        `).get(id, artifactPart) as { remote_id: string; remote_url: string | null } | undefined;
        if (verified) return { remoteId: verified.remote_id, remoteUrl: verified.remote_url, verified: true };
        // A failed attempt keeps its ID only when the provider (or its owner)
        // removed the video: nothing exists to duplicate.
        const attempt = this.database.prepare(`
            SELECT remote_id, remote_url FROM upload_attempts
            WHERE recording_id = ? AND artifact_part = ? AND remote_id IS NOT NULL AND status <> 'failed'
            ORDER BY started_at DESC LIMIT 1
        `).get(id, artifactPart) as { remote_id: string; remote_url: string | null } | undefined;
        if (attempt) return { remoteId: attempt.remote_id, remoteUrl: attempt.remote_url, verified: false };
        return null;
    }

    listVerifiedUploadParts(id: string): Array<{
        part: ProductionArtifactPart;
        remoteId: string;
        remoteUrl: string;
        verifiedAt: string;
    }> {
        const rows = this.database.prepare(`
            SELECT artifact_part, remote_id, remote_url, verified_at
            FROM remote_uploads WHERE recording_id = ? ORDER BY verified_at, artifact_part
        `).all(id) as unknown as Array<{
            artifact_part: ProductionArtifactPart;
            remote_id: string;
            remote_url: string;
            verified_at: string;
        }>;
        return rows.map((row) => ({
            part: row.artifact_part,
            remoteId: row.remote_id,
            remoteUrl: row.remote_url,
            verifiedAt: row.verified_at,
        }));
    }

    makePendingConfirmationDue(id: string, now = new Date()): number {
        const result = this.database.prepare(`
            UPDATE upload_confirmations SET confirm_after = ?
            WHERE recording_id = ? AND status = 'pending'
        `).run(now.toISOString(), id);
        return Number(result.changes);
    }

    transitionToCleanupEligible(id: string, reason: string, now = new Date()): Recording {
        const recording = this.requireRecording(id);
        if (recording.state === "cleanup_eligible") return recording;
        return this.transition(id, recording.state, "cleanup_eligible", reason, now);
    }

    findRecordingByBasename(provider: string, basename: string): Recording | null {
        const row = this.database.prepare(`
            SELECT * FROM recordings
            WHERE provider = ? AND source_path GLOB ? LIMIT 1
        `).get(provider, `*/${basename}`) as RecordingRow | undefined;
        return row ? mapRecording(row) : null;
    }

    listUploadContradictions(): Array<{ id: string; state: PipelineState }> {
        const rows = this.database.prepare(`
            SELECT r.id, r.state FROM recordings r JOIN artifacts p ON p.recording_id = r.id
            WHERE r.state IN ('xvideos_admitted', 'xvideos_uploading', 'xvideos_uploaded', 'xvideos_uncertain')
              AND NOT EXISTS (SELECT 1 FROM upload_attempts a
                  WHERE a.recording_id = r.id AND a.artifact_part = p.part AND a.remote_id IS NOT NULL)
              AND NOT EXISTS (SELECT 1 FROM remote_uploads v
                  WHERE v.recording_id = r.id AND v.artifact_part = p.part)
              AND NOT EXISTS (SELECT 1 FROM upload_confirmations c
                  WHERE c.recording_id = r.id AND c.status = 'pending')
        `).all() as unknown as Array<{ id: string; state: PipelineState }>;
        return rows;
    }

    // Schema 12: SQLite cannot alter a CHECK, so a table whose part check
    // predates "shapeN" is copied into a new table with the wider check.
    private rebuildLegacyPartChecks(): void {
        const tables = this.database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'")
            .all() as unknown as Array<{ name: string; sql: string }>;
        for (const table of tables) {
            if (!LEGACY_PART_CHECKS.some(([legacy]) => table.sql.includes(legacy))) continue;
            const referenced = tables.some((other) => other.name !== table.name
                && new RegExp(`REFERENCES\\s+"?${table.name}"?\\s*\\(`).test(other.sql));
            if (referenced) throw new Error(`Cannot rebuild ${table.name}: other tables reference it`);
            const indexes = (this.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL")
                .all(table.name) as unknown as Array<{ sql: string }>).map((index) => index.sql);
            let sql = table.sql;
            for (const [legacy, wider] of LEGACY_PART_CHECKS) sql = sql.split(legacy).join(wider);
            const rebuilt = `${table.name}_v12`;
            sql = sql.replace(/^CREATE TABLE\s+("?)[A-Za-z_]+\1/, `CREATE TABLE ${rebuilt}`);
            this.transaction(() => {
                this.database.exec(`${sql};
                    INSERT INTO ${rebuilt} SELECT * FROM "${table.name}";
                    DROP TABLE "${table.name}";
                    ALTER TABLE ${rebuilt} RENAME TO ${table.name};`);
                for (const index of indexes) this.database.exec(index);
            });
        }
    }

    recordManualPieces(id: string, pieces: readonly ManualPiece[], reason: string, now = new Date()): void {
        this.requireRecording(id);
        const insert = this.database.prepare(`INSERT INTO manual_pieces (
                recording_id, part, segment_indexes_json, duration_seconds, source_dimensions_json, reason, recorded_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(recording_id, part) DO UPDATE SET segment_indexes_json = excluded.segment_indexes_json,
                duration_seconds = excluded.duration_seconds, source_dimensions_json = excluded.source_dimensions_json,
                reason = excluded.reason, recorded_at = excluded.recorded_at`);
        this.transaction(() => {
            for (const piece of pieces) {
                insert.run(id, piece.part, JSON.stringify(piece.segmentIndexes), piece.durationSeconds,
                    JSON.stringify(piece.sourceDimensions), reason, now.toISOString());
            }
        });
    }

    // Pieces of shape splits too short to upload, for a person to handle.
    listManualPieces(id?: string): Array<ManualPiece & { recordingId: string; reason: string; recordedAt: string }> {
        const rows = (id === undefined
            ? this.database.prepare("SELECT * FROM manual_pieces ORDER BY recording_id, part").all()
            : this.database.prepare("SELECT * FROM manual_pieces WHERE recording_id = ? ORDER BY part").all(id)) as unknown as Array<{
                recording_id: string; part: ProductionArtifactPart; segment_indexes_json: string; duration_seconds: number;
                source_dimensions_json: string; reason: string; recorded_at: string;
            }>;
        return rows.map((row) => ({
            recordingId: row.recording_id,
            part: row.part,
            segmentIndexes: JSON.parse(row.segment_indexes_json) as number[],
            durationSeconds: row.duration_seconds,
            sourceDimensions: JSON.parse(row.source_dimensions_json) as string[],
            reason: row.reason,
            recordedAt: row.recorded_at,
        }));
    }

    // Disk is the source of truth: the source folder is gone, so forget the
    // recording entirely — except the ISP billing truth in bandwidth_events.
    deleteRecording(id: string): void {
        this.transaction(() => {
            for (const table of [
                "upload_confirmations", "upload_attempts", "upload_reservations",
                "remote_uploads", "recording_provenance", "upload_metadata",
                "descriptions", "production_artifact_queue", "resolution_review_artifacts", "artifact_variants",
                "remux_outputs", "artifacts", "manual_pieces", "state_events",
            ]) {
                this.database.prepare(`DELETE FROM ${table} WHERE recording_id = ?`).run(id);
            }
            this.database.prepare("DELETE FROM recordings WHERE id = ?").run(id);
        });
    }

    // The folder's video already exists on XVideos: park it as uncertain with
    // the known edit ID and let the daily reconcile confirm it online.
    parkUploadedCopy(id: string, remoteId: string, remoteUrl: string | null, now = new Date(), provider: ActiveUploadProvider = "xvideos"): Recording {
        assertUploadProvider(provider);
        if (!remoteId.trim()) throw new Error("Existing upload requires a remote identity");
        const timestamp = now.toISOString();
        this.transaction(() => {
            const recording = this.requireRecording(id);
            const attemptId = randomUUID();
            this.database.prepare(`
                INSERT INTO upload_attempts (
                    id, reservation_id, recording_id, provider, status, phase,
                    progress_bytes, transmitted_bytes, remote_id, remote_url, error, started_at, completed_at
                ) VALUES (?, NULL, ?, ?, 'uncertain', 'metadata_submitting', 0, 0, ?, ?, ?, ?, ?)
            `).run(attemptId, id, provider, remoteId, remoteUrl,
                `parked: already uploaded on ${provider}`, timestamp, timestamp);
            this.database.prepare(`
                INSERT INTO upload_confirmations (
                    attempt_id, recording_id, confirm_after, status, checked_at
                ) VALUES (?, ?, ?, 'pending', NULL)
            `).run(attemptId, id, timestamp);
            this.updateStateInTransaction(id, recording.state, "xvideos_uncertain",
                `already uploaded on ${provider}; parked for verification`, timestamp);
        });
        return this.requireRecording(id);
    }

    getUncertainUploadRemote(attemptId: string): { remoteId: string; remoteUrl: string | null } | null {
        const row = this.database.prepare(`
            SELECT remote_id, remote_url FROM upload_attempts WHERE id = ? AND status = 'uncertain'
        `).get(attemptId) as { remote_id: string | null; remote_url: string | null } | undefined;
        if (!row?.remote_id) return null;
        return { remoteId: row.remote_id, remoteUrl: row.remote_url };
    }

    canAttemptUpload(id: string, now = new Date()): boolean {
        const row = this.database.prepare(`SELECT MAX(retry_not_before) AS deadline FROM upload_attempts
            WHERE recording_id = ? AND artifact_part = ? AND
                (transfer_started = 1 OR progress_bytes > 0 OR transmitted_bytes > 0 OR status IN ('uncertain', 'accepted'))`)
            .get(id, this.getArtifactPart(id) ?? "full") as { deadline: string | null };
        return !row.deadline || row.deadline <= now.toISOString();
    }

    hasUploadAttempt(id: string): boolean {
        return !!this.database.prepare(`SELECT 1 FROM upload_attempts WHERE recording_id = ? AND artifact_part = ? LIMIT 1`)
            .get(id, this.getArtifactPart(id) ?? "full");
    }

    releasePlaceholderReferences(now = new Date()): number {
        return this.transaction(() => {
            let released = 0;
            for (const r of this.list("provenance_review_required")) {
                if (!allowsPlaceholder(this.getProvenance(r.id))) continue;
                this.updateStateInTransaction(r.id, r.state, "described", "unresolved source reference allowed as TODO LATER", now.toISOString());
                released++;
            }
            return released;
        });
    }

    // A clean negative search is evidence, not proof that bytes never arrived.
    // Requeue only after the persisted weekly deadline; known IDs and provider
    // visibility warnings are never reasons to upload the same video again.
    recordUploadLookup(attemptId: string, result: "absent" | "ambiguous" | "found", now = new Date()): boolean {
        return this.transaction(() => {
            const a = this.database.prepare(`SELECT recording_id, remote_id, retry_not_before
                FROM upload_attempts WHERE id = ? AND status = 'uncertain'`).get(attemptId) as {
                    recording_id: string; remote_id: string | null; retry_not_before: string;
                } | undefined;
            if (!a) return false;
            this.database.prepare(`UPDATE upload_attempts SET lookup_state = ?, lookup_checked_at = ? WHERE id = ?`)
                .run(result, now.toISOString(), attemptId);
            // Visibility labels are informational and never hold back a retry.
            if (result !== "absent" || a.remote_id || !a.retry_not_before
                || now.toISOString() < a.retry_not_before) return false;
            this.database.prepare(`UPDATE upload_attempts SET status = 'failed', error = ? WHERE id = ?`)
                .run("Authenticated filename lookup found no entry after weekly retry deadline", attemptId);
            this.database.prepare(`UPDATE upload_confirmations SET status = 'absent', checked_at = ? WHERE attempt_id = ?`)
                .run(now.toISOString(), attemptId);
            this.updateStateInTransaction(a.recording_id, "xvideos_uncertain", "metadata_ready",
                "not found after reconciliation; weekly retry eligible", now.toISOString());
            return true;
        });
    }

    verifyUpload(attemptId: string, remoteId: string, remoteUrl: string, now = new Date()): Recording {
        return this.transaction(() => {
            const r = this.reconcileUncertain(attemptId, remoteId, remoteUrl, now);
            return this.markRemoteVerified(r.id, remoteId, remoteUrl, now);
        });
    }

    // Repair the old crash window between acceptance and verification. This
    // never sends bytes; it restores a pending check of the already known ID.
    recoverAcceptedVerifications(now = new Date()): number {
        return this.transaction(() => {
            const rows = this.database.prepare(`SELECT a.id, a.recording_id FROM upload_attempts a
                JOIN recordings r ON r.id = a.recording_id JOIN artifacts p ON p.recording_id = r.id
                WHERE r.state = 'xvideos_uploaded' AND a.status = 'accepted' AND a.artifact_part = p.part
                    AND a.remote_id IS NOT NULL AND NOT EXISTS
                    (SELECT 1 FROM remote_uploads u WHERE u.recording_id = r.id AND u.artifact_part = p.part)`)
                .all() as unknown as Array<{ id: string; recording_id: string }>;
            for (const row of rows) {
                this.database.prepare(`UPDATE upload_attempts SET status = 'uncertain' WHERE id = ?`).run(row.id);
                this.database.prepare(`INSERT INTO upload_confirmations (attempt_id, recording_id, confirm_after, status, checked_at)
                    VALUES (?, ?, ?, 'pending', NULL) ON CONFLICT(attempt_id) DO UPDATE SET status = 'pending', confirm_after = excluded.confirm_after`)
                    .run(row.id, row.recording_id, now.toISOString());
                this.updateStateInTransaction(row.recording_id, "xvideos_uploaded", "xvideos_uncertain",
                    "restore interrupted acceptance-to-verification check", now.toISOString());
            }
            return rows.length;
        });
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
        now = new Date(),
    ): Recording {
        const timestamp = now.toISOString();
        this.transaction(() => {
            const currentArtifact = this.database.prepare(`
                SELECT part FROM artifacts WHERE recording_id = ?
            `).get(id) as { part: ProductionArtifactPart } | undefined;
            const current = currentArtifact ?? { part: "full" as const };
            const attempt = this.database.prepare(`
                SELECT id, artifact_part, reservation_id FROM upload_attempts
                WHERE recording_id = ? AND artifact_part = ? AND status = 'accepted'
                    AND remote_id = ? AND remote_url = ?
                ORDER BY completed_at DESC LIMIT 1
            `).get(id, current.part, remoteId, remoteUrl) as {
                id: string;
                artifact_part: ProductionArtifactPart;
                reservation_id: string | null;
            } | undefined;
            if (!attempt) throw new Error("Verification does not match an accepted upload attempt");
            if (!currentArtifact && attempt.reservation_id !== null) throw new Error("Verification has no current production artifact");
            this.database.prepare(`
                INSERT INTO remote_uploads (
                    recording_id, artifact_part, attempt_id, remote_id, remote_url, verified_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(recording_id, artifact_part) DO UPDATE SET
                    attempt_id = excluded.attempt_id,
                    remote_id = excluded.remote_id,
                    remote_url = excluded.remote_url,
                    verified_at = excluded.verified_at
            `).run(id, current.part, attempt.id, remoteId, remoteUrl, timestamp);

            const queued = this.database.prepare(`
                SELECT * FROM production_artifact_queue
                WHERE recording_id = ? ORDER BY queue_position LIMIT 1
            `).get(id) as QueuedProductionArtifactRow | undefined;
            if (!queued) {
                this.updateStateInTransaction(id, "xvideos_uploaded", "xvideos_verified",
                    `authenticated edit-page verification for ${current.part}`, timestamp);
                return;
            }
            this.database.prepare("DELETE FROM upload_metadata WHERE recording_id = ?").run(id);
            this.database.prepare("DELETE FROM descriptions WHERE recording_id = ?").run(id);
            this.database.prepare(`
                UPDATE artifacts SET part = ?, path = ?, size_bytes = ?, sha256 = ?, validated_at = ?
                WHERE recording_id = ?
            `).run(queued.part, queued.path, queued.size_bytes, queued.sha256, queued.validated_at, id);
            this.database.prepare(`
                DELETE FROM production_artifact_queue WHERE recording_id = ? AND part = ?
            `).run(id, queued.part);
            this.updateStateInTransaction(id, "xvideos_uploaded", "artifact_valid",
                `${current.part} verified; promoted queued ${queued.part} artifact`, timestamp);
        });
        return this.requireRecording(id);
    }

    dueUploadConfirmations(now = new Date()): UploadConfirmation[] {
        const rows = this.database.prepare(`
            SELECT c.*, a.recording_id, a.provider
            FROM upload_confirmations c JOIN upload_attempts a ON a.id = c.attempt_id
            WHERE c.status = 'pending' AND c.confirm_after <= ?
            ORDER BY c.confirm_after, c.attempt_id
        `).all(now.toISOString()) as unknown as Array<{
            attempt_id: string;
            provider: string;
            recording_id: string;
            confirm_after: string;
            status: UploadConfirmation["status"];
            checked_at: string | null;
        }>;
        return rows.map((row) => ({
            // Legacy manual sync mistakenly stored the origin (tango/fc2/sc).
            // Those predate Porntrex support and are all XVideos identities.
            uploadProvider: row.provider === "porntrex" ? "porntrex" : "xvideos",
            attemptId: row.attempt_id,
            recordingId: row.recording_id,
            confirmAfter: row.confirm_after,
            status: row.status,
            checkedAt: row.checked_at,
        }));
    }

    settleConfirmationManualReview(attemptId: string, now = new Date()): void {
        this.database.prepare(`
            UPDATE upload_confirmations SET status = 'absent', checked_at = ?
            WHERE attempt_id = ? AND status = 'pending'
        `).run(now.toISOString(), attemptId);
    }

    recordUploadEvidence(attemptId: string, evidence: Record<string, unknown>, now = new Date()): void {
        this.transaction(() => {
            const row = this.database.prepare("SELECT evidence_json FROM upload_attempts WHERE id = ?")
                .get(attemptId) as { evidence_json: string } | undefined;
            if (!row) throw new Error(`Unknown upload attempt ${attemptId}`);
            const history = JSON.parse(row.evidence_json) as unknown[];
            history.push({ ...evidence, checkedAt: now.toISOString() });
            this.database.prepare("UPDATE upload_attempts SET evidence_json = ? WHERE id = ?")
                .run(JSON.stringify(history.slice(-16)), attemptId);
            this.recordProviderMessages(attemptId, [evidence.text, evidence.limitedVisibility]
                .filter((value): value is string => typeof value === "string").join("\n"), now);
            if (evidence.stage === "remote_identity_captured" && typeof evidence.remoteId === "string" && /^\d+$/.test(evidence.remoteId)) {
                this.database.prepare(`UPDATE upload_attempts SET remote_id = ?
                    WHERE id = ? AND status IN ('started', 'uncertain') AND remote_id IS NULL`).run(evidence.remoteId, attemptId);
            }
        });
    }

    // Submission-page messages: a word rejection is learned per provider and
    // marks the attempt; a visibility label is stored for information only.
    private recordProviderMessages(attemptId: string, text: string, now: Date): void {
        if (!text) return;
        const phrases = rejectedPhrases(text);
        const warning = limitedVisibilityWarning(text.replace(/Sorry, '[^'\n]+' is not allowed here\.?/g, ""));
        if (warning) this.database.prepare("UPDATE upload_attempts SET limited_visibility = ? WHERE id = ?").run(warning, attemptId);
        if (!phrases.length) return;
        const attempt = this.database.prepare("SELECT provider, metadata_rejection FROM upload_attempts WHERE id = ?")
            .get(attemptId) as { provider: string; metadata_rejection: string | null } | undefined;
        if (!attempt) return;
        const known = attempt.metadata_rejection?.split(", ").filter(Boolean) ?? [];
        this.database.prepare("UPDATE upload_attempts SET metadata_rejection = ? WHERE id = ?")
            .run([...new Set([...known, ...phrases])].join(", "), attemptId);
        // Legacy manual-sync rows may still carry a source label; those are XVideos.
        this.recordRejectedPhrases(attempt.provider === "porntrex" ? "porntrex" : "xvideos", phrases, attemptId, now);
    }

    recordRejectedPhrases(provider: ActiveUploadProvider, phrases: readonly string[], attemptId: string | null, now = new Date()): void {
        assertUploadProvider(provider);
        const insert = this.database.prepare(`INSERT OR IGNORE INTO rejected_phrases (provider, phrase, first_seen_at, attempt_id)
            VALUES (?, ?, ?, ?)`);
        for (const phrase of phrases) {
            const normalized = phrase.trim().toLowerCase();
            if (normalized) insert.run(provider, normalized, now.toISOString(), attemptId);
        }
    }

    listRejectedPhrases(provider?: ActiveUploadProvider): string[] {
        const rows = (provider
            ? this.database.prepare("SELECT DISTINCT phrase FROM rejected_phrases WHERE provider = ? ORDER BY phrase").all(provider)
            : this.database.prepare("SELECT DISTINCT phrase FROM rejected_phrases ORDER BY phrase").all()) as unknown as Array<{ phrase: string }>;
        return rows.map((row) => row.phrase);
    }

    // The local model rewrote the description text to avoid rejected phrases:
    // store the new text with the prompt version it now satisfies, and the
    // metadata recomposed from it, together. The recording stays upload-ready.
    replaceDescriptionText(id: string, output: { title: string; description: string }, promptVersion: string,
        metadata: { title: string; description: string; tags: readonly string[] }, reason: string, now = new Date()): Recording {
        const timestamp = now.toISOString();
        this.transaction(() => {
            const recording = this.requireRecording(id);
            if (recording.state !== "metadata_ready") throw new Error(`Recording ${id} is not upload-ready`);
            const current = this.getDescription(id);
            if (!current) throw new Error(`Recording ${id} has no description`);
            this.database.prepare("UPDATE descriptions SET output_json = ?, prompt_version = ? WHERE recording_id = ?")
                .run(JSON.stringify({ ...(current.output as object), ...output }), promptVersion, id);
            this.database.prepare("UPDATE upload_metadata SET title = ?, description = ?, tags_json = ?, created_at = ? WHERE recording_id = ?")
                .run(metadata.title, metadata.description, JSON.stringify(metadata.tags), timestamp, id);
            this.insertEvent(id, "metadata_ready", "metadata_ready", reason, timestamp);
        });
        return this.requireRecording(id);
    }

    // Metadata that contains a phrase the destination rejects is described
    // again with the learned phrases appended to the prompt.
    returnForRedescription(id: string, reason: string, now = new Date()): Recording {
        return this.transition(id, "metadata_ready", "artifact_valid", reason, now);
    }

    // A definitive provider refusal (no remote video exists) does not hold the
    // weekly duplicate-safety slot; acceptance-unknown attempts still do.
    releaseRetryDeadline(attemptId: string): void {
        this.database.prepare("UPDATE upload_attempts SET retry_not_before = started_at WHERE id = ? AND status = 'failed'")
            .run(attemptId);
    }

    // Porntrex creates the video only when its metadata form is submitted.
    // Uncertain attempts that never reached that click published nothing:
    // settle them as plain failures, without the weekly duplicate hold.
    settleUnsubmittedAttempts(provider: ActiveUploadProvider, now = new Date()): string[] {
        assertUploadProvider(provider);
        if (provider !== "porntrex") return [];
        return this.transaction(() => {
            const rows = this.database.prepare(`SELECT a.id, a.recording_id FROM upload_attempts a
                JOIN recordings r ON r.id = a.recording_id
                WHERE a.provider = ? AND a.status = 'uncertain' AND a.phase <> 'metadata_submitting'
                    AND a.remote_id IS NULL AND r.state = 'xvideos_uncertain'`).all(provider) as unknown as Array<{ id: string; recording_id: string }>;
            const timestamp = now.toISOString();
            for (const row of rows) {
                this.database.prepare(`UPDATE upload_attempts SET status = 'failed', retry_not_before = started_at,
                    error = COALESCE(error || '; ', '') || 'settled: metadata form never submitted, no video exists' WHERE id = ?`).run(row.id);
                this.database.prepare(`UPDATE upload_confirmations SET status = 'absent', checked_at = ?
                    WHERE attempt_id = ? AND status = 'pending'`).run(timestamp, row.id);
                this.updateStateInTransaction(row.recording_id, "xvideos_uncertain", "metadata_ready",
                    `${provider} metadata form never submitted; no video exists`, timestamp);
            }
            return rows.map((row) => row.recording_id);
        });
    }

    // Remote IDs the ledger knows about in any generation.
    knownRemoteIds(): Set<string> {
        const rows = this.database.prepare(`SELECT remote_id FROM upload_attempts WHERE remote_id IS NOT NULL
            UNION SELECT remote_id FROM remote_uploads UNION SELECT remote_id FROM retired_remote_uploads`)
            .all() as unknown as Array<{ remote_id: string }>;
        return new Set(rows.map((row) => row.remote_id));
    }

    listVerifiedRemoteUploads(provider: ActiveUploadProvider): Array<{ recordingId: string; remoteId: string }> {
        return (this.database.prepare(`SELECT u.recording_id, u.remote_id FROM remote_uploads u
            JOIN upload_attempts a ON a.id = u.attempt_id
            WHERE (CASE WHEN a.provider = 'porntrex' THEN 'porntrex' ELSE 'xvideos' END) = ?
            ORDER BY u.recording_id`).all(provider) as unknown as Array<{ recording_id: string; remote_id: string }>)
            .map((row) => ({ recordingId: row.recording_id, remoteId: row.remote_id }));
    }

    // The video existed on the provider (it had this ID) and now does not:
    // the provider removed it, with or without notice. Blocked for a person,
    // and that provider never gets the recording again; `retry` unblocks it
    // once another provider is active.
    markProviderRemoved(attemptId: string, remoteId: string, reason: string, now = new Date()): boolean {
        return this.transaction(() => {
            const attempt = this.database.prepare(`SELECT recording_id, provider FROM upload_attempts WHERE id = ? AND status = 'uncertain'`)
                .get(attemptId) as { recording_id: string; provider: string } | undefined;
            if (!attempt) return false;
            this.recordUploadEvidence(attemptId, { stage: "provider_removed", remoteId, reason }, now);
            const timestamp = now.toISOString();
            this.database.prepare(`INSERT OR IGNORE INTO provider_removals (recording_id, provider, remote_id, reason, removed_at)
                VALUES (?, ?, ?, ?, ?)`).run(attempt.recording_id, attempt.provider === "porntrex" ? "porntrex" : "xvideos",
                remoteId, reason, timestamp);
            this.database.prepare(`UPDATE upload_attempts SET status = 'failed', error = ?, retry_not_before = started_at WHERE id = ?`)
                .run(reason, attemptId);
            this.database.prepare(`UPDATE upload_confirmations SET status = 'absent', checked_at = ? WHERE attempt_id = ? AND status = 'pending'`)
                .run(timestamp, attemptId);
            this.updateStateInTransaction(attempt.recording_id, "xvideos_uncertain", "metadata_ready", reason, timestamp);
            this.updateStateInTransaction(attempt.recording_id, "metadata_ready", "blocked", reason, timestamp);
            this.database.prepare("UPDATE recordings SET block_reason = ? WHERE id = ?").run(reason, attempt.recording_id);
            return true;
        });
    }

    providerRemovals(id: string): Array<{ provider: ActiveUploadProvider; remoteId: string; reason: string; removedAt: string }> {
        return (this.database.prepare(`SELECT provider, remote_id, reason, removed_at FROM provider_removals
            WHERE recording_id = ? ORDER BY removed_at`).all(id) as unknown as Array<{
            provider: ActiveUploadProvider; remote_id: string; reason: string; removed_at: string;
        }>).map((row) => ({ provider: row.provider, remoteId: row.remote_id, reason: row.reason, removedAt: row.removed_at }));
    }

    // HTTP 404 on the provider's edit page: the ID does not exist (deleted or
    // never created). Drop it so a filename lookup can settle the attempt.
    detachMissingRemote(attemptId: string, remoteId: string, now = new Date()): boolean {
        const result = this.database.prepare(`UPDATE upload_attempts SET remote_id = NULL, remote_url = NULL
            WHERE id = ? AND status = 'uncertain' AND remote_id = ?`).run(attemptId, remoteId);
        if (!result.changes) return false;
        this.recordUploadEvidence(attemptId, { stage: "remote_missing", remoteId,
            reason: "Provider edit page returned 404; the ID does not exist" }, now);
        return true;
    }

    // Indefinite pause that names its reason, for problems only a person can
    // fix (such as the provider login moving to another device).
    pauseForAttention(reason: string, now = new Date()): CampaignControl {
        this.database.prepare(`UPDATE campaign_control SET state = 'paused', resume_at = NULL, attention_reason = ?, updated_at = ?
            WHERE id = 1`).run(reason, now.toISOString());
        return this.getCampaignControl();
    }

    recordProviderSessionEvent(event: {
        provider: ActiveUploadProvider; kind: string; loggedIn?: boolean | null; fingerprint?: string | null;
        passwordLoginAt?: string | null; note?: string | null;
    }, now = new Date()): void {
        assertUploadProvider(event.provider);
        this.database.prepare(`INSERT INTO provider_session_events (provider, occurred_at, kind, logged_in, fingerprint, password_login_at, note)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run(event.provider, now.toISOString(), event.kind,
            event.loggedIn === undefined || event.loggedIn === null ? null : event.loggedIn ? 1 : 0,
            event.fingerprint ?? null, event.passwordLoginAt ?? null, event.note ?? null);
    }

    listProviderSessionEvents(provider: ActiveUploadProvider, sinceIso = "0000"): Array<{
        occurredAt: string; kind: string; loggedIn: boolean | null; fingerprint: string | null; passwordLoginAt: string | null; note: string | null;
    }> {
        return (this.database.prepare(`SELECT * FROM provider_session_events WHERE provider = ? AND occurred_at >= ?
            ORDER BY occurred_at, id`).all(provider, sinceIso) as unknown as Array<{
            occurred_at: string; kind: string; logged_in: number | null; fingerprint: string | null; password_login_at: string | null; note: string | null;
        }>).map((row) => ({ occurredAt: row.occurred_at, kind: row.kind, loggedIn: row.logged_in === null ? null : row.logged_in === 1,
            fingerprint: row.fingerprint, passwordLoginAt: row.password_login_at, note: row.note }));
    }

    // Porntrex uploads that reached the provider, newest first, with what the
    // pipeline submitted and where verification stands.
    listPorntrexUploads(limit = 25): Array<{
        recordingId: string; state: string; remoteId: string | null; startedAt: string; confirmAfter: string | null;
        verifiedAt: string | null; metadata: { title: string; description: string; tags: string[] } | null;
    }> {
        return (this.database.prepare(`SELECT a.recording_id, r.state, COALESCE(u.remote_id, a.remote_id) AS remote_id, a.started_at,
                c.confirm_after, u.verified_at, m.title, m.description, m.tags_json
            FROM upload_attempts a JOIN recordings r ON r.id = a.recording_id
            LEFT JOIN upload_confirmations c ON c.attempt_id = a.id AND c.status = 'pending'
            LEFT JOIN remote_uploads u ON u.attempt_id = a.id
            LEFT JOIN upload_metadata m ON m.recording_id = a.recording_id
            WHERE a.provider = 'porntrex' AND a.status IN ('uncertain', 'accepted')
            ORDER BY a.started_at DESC LIMIT ?`).all(limit) as unknown as Array<{
            recording_id: string; state: string; remote_id: string | null; started_at: string; confirm_after: string | null;
            verified_at: string | null; title: string | null; description: string | null; tags_json: string | null;
        }>).map((row) => ({ recordingId: row.recording_id, state: row.state, remoteId: row.remote_id, startedAt: row.started_at,
            confirmAfter: row.confirm_after, verifiedAt: row.verified_at,
            metadata: row.title === null ? null : { title: row.title, description: row.description ?? "", tags: JSON.parse(row.tags_json ?? "[]") as string[] } }));
    }

    listActiveUploadAttempts(): Array<{ id: string; recordingId: string; provider: string }> {
        return (this.database.prepare("SELECT id, recording_id, provider FROM upload_attempts WHERE status = 'started'")
            .all() as unknown as Array<{ id: string; recording_id: string; provider: string }>)
            .map((row) => ({ id: row.id, recordingId: row.recording_id, provider: row.provider }));
    }

    getActiveUploadProvider(): ActiveUploadProvider {
        return this.getCampaignControl().uploadProvider;
    }

    // One destination at a time. The provider being left must be settled
    // first: nothing in flight, no open confirmations and, for XVideos, an
    // account inventory synchronized after its last upload attempt.
    setActiveUploadProvider(provider: ActiveUploadProvider, now = new Date()): CampaignControl {
        assertUploadProvider(provider);
        return this.transaction(() => {
            const control = this.getCampaignControl();
            const leaving = control.uploadProvider;
            if (leaving === provider) return control;
            if (control.state !== "paused") throw new Error("Pause the campaign before switching the upload provider");
            const inFlight = this.database.prepare(`SELECT
                (SELECT count(*) FROM upload_reservations WHERE status = 'reserved')
                + (SELECT count(*) FROM upload_attempts WHERE status = 'started') AS n`).get() as { n: number };
            if (inFlight.n > 0) throw new Error("An upload reservation or attempt is still active; let it finish before switching");
            // Same provider normalization as dueUploadConfirmations: legacy
            // source labels on manual-sync rows are XVideos identities.
            const pending = (this.database.prepare(`SELECT count(*) AS n FROM upload_confirmations c
                JOIN upload_attempts a ON a.id = c.attempt_id
                WHERE c.status = 'pending' AND (CASE WHEN a.provider = 'porntrex' THEN 'porntrex' ELSE 'xvideos' END) = ?`)
                .get(leaving) as { n: number }).n;
            if (pending > 0) {
                throw new Error(`${leaving} still has ${pending} unresolved upload confirmation(s); settle them before switching`);
            }
            if (leaving === "xvideos") {
                const sync = this.getProviderInventorySync("xvideos");
                const last = (this.database.prepare("SELECT max(started_at) AS at FROM upload_attempts WHERE provider = 'xvideos'")
                    .get() as { at: string | null }).at;
                if (!sync || (last !== null && sync.completedAt < last)) {
                    throw new Error("Synchronize the XVideos inventory (xvideos-sync --apply) after its last upload before switching away");
                }
            }
            this.database.prepare("UPDATE campaign_control SET upload_provider = ?, updated_at = ? WHERE id = 1")
                .run(provider, now.toISOString());
            this.database.prepare("INSERT INTO upload_provider_events (changed_at, from_provider, to_provider) VALUES (?, ?, ?)")
                .run(now.toISOString(), leaving, provider);
            return this.getCampaignControl();
        });
    }

    listUploadProviderEvents(): Array<{ changedAt: string; fromProvider: string; toProvider: string }> {
        return (this.database.prepare("SELECT * FROM upload_provider_events ORDER BY changed_at").all() as unknown as Array<{
            changed_at: string; from_provider: string; to_provider: string;
        }>).map((row) => ({ changedAt: row.changed_at, fromProvider: row.from_provider, toProvider: row.to_provider }));
    }

    // A complete account listing replaces the previous one. It is the provider
    // truth the other destination consults instead of logging in elsewhere.
    replaceProviderInventory(provider: ActiveUploadProvider, entries: readonly ProviderInventoryEntry[], now = new Date()): void {
        assertUploadProvider(provider);
        this.transaction(() => {
            this.database.prepare("DELETE FROM provider_inventory WHERE provider = ?").run(provider);
            const insert = this.database.prepare(`INSERT INTO provider_inventory (
                provider, remote_id, recording_id, title, remote_url, status, removal_pending, observed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
            for (const entry of entries) {
                insert.run(provider, entry.remoteId, entry.recordingId, entry.title, entry.remoteUrl, entry.status,
                    isRemovalPendingStatus(entry.status) ? 1 : 0, now.toISOString());
            }
            this.database.prepare(`INSERT INTO provider_inventory_syncs (provider, completed_at, total) VALUES (?, ?, ?)
                ON CONFLICT(provider) DO UPDATE SET completed_at = excluded.completed_at, total = excluded.total`)
                .run(provider, now.toISOString(), entries.length);
        });
    }

    getProviderInventorySync(provider: ActiveUploadProvider): { completedAt: string; total: number } | null {
        const row = this.database.prepare("SELECT completed_at, total FROM provider_inventory_syncs WHERE provider = ?")
            .get(provider) as { completed_at: string; total: number } | undefined;
        return row ? { completedAt: row.completed_at, total: row.total } : null;
    }

    listProviderInventory(provider: ActiveUploadProvider): ProviderInventoryEntry[] {
        return (this.database.prepare(`SELECT remote_id, recording_id, title, remote_url, status, removal_pending FROM provider_inventory
            WHERE provider = ? ORDER BY remote_id`).all(provider) as unknown as Array<{
            remote_id: string; recording_id: string | null; title: string; remote_url: string | null; status: string; removal_pending: number;
        }>).map((row) => ({ remoteId: row.remote_id, recordingId: row.recording_id, title: row.title,
            remoteUrl: row.remote_url, status: row.status, removalPending: row.removal_pending === 1 }));
    }

    // Copies of this recording on any synchronized provider account. Videos
    // being deleted do not count: they are on their way to 404.
    findProviderInventoryCopies(recordingId: string): Array<{ provider: string; remoteId: string; status: string }> {
        return (this.database.prepare(`SELECT provider, remote_id, status FROM provider_inventory
            WHERE recording_id = ? AND removal_pending = 0 ORDER BY provider, remote_id`).all(recordingId) as unknown as Array<{
            provider: string; remote_id: string; status: string;
        }>).map((row) => ({ provider: row.provider, remoteId: row.remote_id, status: row.status }));
    }

    postponeConfirmation(attemptId: string, reason: string, now = new Date(), delayMilliseconds = 24 * 60 * 60_000): void {
        const update = this.database.prepare(`UPDATE upload_confirmations SET confirm_after = ?, checked_at = ?
            WHERE attempt_id = ? AND status = 'pending'`)
            .run(new Date(now.getTime() + delayMilliseconds).toISOString(), now.toISOString(), attemptId);
        if (!update.changes) return;
        this.recordUploadEvidence(attemptId, { stage: "verification_wait", reason }, now);
    }

    attachUncertainRemote(attemptId: string, remoteId: string): void {
        if (!/^\d+$/.test(remoteId)) throw new Error("Invalid recovered upload ID");
        this.database.prepare("UPDATE upload_attempts SET remote_id = ? WHERE id = ? AND status = 'uncertain' AND remote_id IS NULL")
            .run(remoteId, attemptId);
    }

    latestUploadDiagnostics(recordingId: string): unknown {
        const row = this.database.prepare(`SELECT a.provider AS upload_provider, a.status, a.error, a.evidence_json, a.limited_visibility, a.metadata_rejection,
            a.retry_not_before, a.lookup_state, a.lookup_checked_at, c.confirm_after, c.status AS confirmation_status
            FROM upload_attempts a LEFT JOIN upload_confirmations c ON c.attempt_id = a.id
            WHERE a.recording_id = ? ORDER BY a.started_at DESC LIMIT 1`).get(recordingId) as
            { evidence_json: string; [key: string]: unknown } | undefined;
        if (!row) return null;
        const { evidence_json, ...rest } = row;
        return { ...rest, evidence: JSON.parse(evidence_json) };
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
        // Nested state-machine operations join their caller's transaction.
        // Exceptions propagate to the outer rollback; no partial commits.
        if (this.inTransaction) return operation();
        this.database.exec("BEGIN IMMEDIATE");
        this.inTransaction = true;
        try {
            const result = operation();
            this.database.exec("COMMIT");
            return result;
        } catch (error) {
            this.database.exec("ROLLBACK");
            throw error;
        } finally {
            this.inTransaction = false;
        }
    }
    private inTransaction = false;
}
