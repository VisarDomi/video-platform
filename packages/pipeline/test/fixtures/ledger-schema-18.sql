CREATE TABLE schema_version (
        version INTEGER NOT NULL
    ) STRICT;
CREATE TABLE recordings (
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
CREATE INDEX recordings_state_idx ON recordings (state, created_at);
CREATE TABLE state_events (
        id INTEGER PRIMARY KEY,
        recording_id TEXT NOT NULL REFERENCES recordings(id),
        from_state TEXT,
        to_state TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL
    ) STRICT;
CREATE TABLE artifacts (
        recording_id TEXT PRIMARY KEY REFERENCES recordings(id),
        part TEXT NOT NULL DEFAULT 'full' CHECK (part IN ('full', 'max1080p', 'nonmax1080p') OR (part GLOB 'shape[1-9]*' AND part NOT GLOB 'shape*[^0-9]*')),
        path TEXT NOT NULL UNIQUE,
        size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
        sha256 TEXT NOT NULL,
        validated_at TEXT NOT NULL
    ) STRICT;
CREATE TABLE production_artifact_queue (
        recording_id TEXT NOT NULL REFERENCES recordings(id),
        part TEXT NOT NULL CHECK (part IN ('max1080p', 'nonmax1080p') OR (part GLOB 'shape[1-9]*' AND part NOT GLOB 'shape*[^0-9]*')),
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
CREATE TABLE artifact_variants (
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
CREATE TABLE resolution_review_artifacts (
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
CREATE TABLE remux_outputs (
        recording_id TEXT PRIMARY KEY REFERENCES recordings(id),
        path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
    ) STRICT;
CREATE TABLE manual_pieces (
        recording_id TEXT NOT NULL REFERENCES recordings(id),
        part TEXT NOT NULL,
        segment_indexes_json TEXT NOT NULL,
        duration_seconds REAL NOT NULL CHECK (duration_seconds >= 0),
        source_dimensions_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (recording_id, part)
    ) STRICT;
CREATE TABLE short_parts (
        recording_id TEXT NOT NULL REFERENCES recordings(id),
        part TEXT NOT NULL CHECK (part IN ('full', 'max1080p', 'nonmax1080p') OR (part GLOB 'shape[1-9]*' AND part NOT GLOB 'shape*[^0-9]*')),
        source_fingerprint TEXT NOT NULL,
        streamer_key TEXT NOT NULL,
        destination_provider TEXT NOT NULL,
        aspect_ratio REAL NOT NULL CHECK (aspect_ratio > 0),
        duration_seconds REAL NOT NULL CHECK (duration_seconds > 0),
        playlist TEXT NOT NULL,
        batch_id TEXT REFERENCES recordings(id),
        verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
        PRIMARY KEY (recording_id, part)
    ) STRICT;
CREATE INDEX short_parts_batch_idx ON short_parts(batch_id);
CREATE TABLE descriptions (
        recording_id TEXT PRIMARY KEY REFERENCES recordings(id),
        artifact_sha256 TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        fps REAL NOT NULL CHECK (fps > 0),
        output_json TEXT NOT NULL,
        evidence_path TEXT NOT NULL,
        created_at TEXT NOT NULL
    ) STRICT;
CREATE TABLE recording_provenance (
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
CREATE INDEX recording_provenance_status_idx ON recording_provenance (resolution_status, updated_at);
CREATE TABLE provenance_overrides (
        provider TEXT NOT NULL,
        observed_identifier TEXT NOT NULL,
        streamer_id TEXT NOT NULL,
        alias TEXT NOT NULL,
        streamer_url TEXT NOT NULL,
        alias_url TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (provider, observed_identifier)
    ) STRICT;
CREATE TABLE upload_metadata (
        recording_id TEXT PRIMARY KEY REFERENCES recordings(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        created_at TEXT NOT NULL
    ) STRICT;
CREATE TABLE upload_reservations (
        id TEXT PRIMARY KEY,
        recording_id TEXT NOT NULL REFERENCES recordings(id),
        artifact_part TEXT NOT NULL DEFAULT 'full' CHECK (artifact_part IN ('full', 'max1080p', 'nonmax1080p') OR (artifact_part GLOB 'shape[1-9]*' AND artifact_part NOT GLOB 'shape*[^0-9]*')),
        provider TEXT NOT NULL,
        calendar_month TEXT NOT NULL,
        reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes > 0),
        status TEXT NOT NULL CHECK (status IN ('reserved', 'consumed', 'released')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        uplink TEXT NOT NULL DEFAULT 'home'
    ) STRICT;
CREATE UNIQUE INDEX one_active_reservation_idx ON upload_reservations (recording_id) WHERE status = 'reserved';
CREATE TABLE upload_attempts (
        id TEXT PRIMARY KEY,
        reservation_id TEXT REFERENCES upload_reservations(id),
        recording_id TEXT NOT NULL REFERENCES recordings(id),
        artifact_part TEXT NOT NULL DEFAULT 'full' CHECK (artifact_part IN ('full', 'max1080p', 'nonmax1080p') OR (artifact_part GLOB 'shape[1-9]*' AND artifact_part NOT GLOB 'shape*[^0-9]*')),
        provider TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('started', 'failed', 'accepted', 'uncertain')),
        phase TEXT NOT NULL DEFAULT 'started' CHECK (phase IN ('started', 'file_uploading', 'file_uploaded', 'metadata_submitting')),
        progress_bytes INTEGER NOT NULL DEFAULT 0 CHECK (progress_bytes >= 0),
        transmitted_bytes INTEGER NOT NULL DEFAULT 0 CHECK (transmitted_bytes >= 0),
        remote_id TEXT,
        remote_url TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        retry_not_before TEXT,
        lookup_state TEXT,
        lookup_checked_at TEXT,
        limited_visibility TEXT,
        metadata_rejection TEXT,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        transfer_started INTEGER NOT NULL DEFAULT 0,
        uplink TEXT NOT NULL DEFAULT 'home'
    ) STRICT;
CREATE TABLE bandwidth_events (
        id INTEGER PRIMARY KEY,
        recording_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        calendar_month TEXT NOT NULL,
        transmitted_bytes INTEGER NOT NULL CHECK (transmitted_bytes >= 0),
        created_at TEXT NOT NULL,
        uplink TEXT NOT NULL DEFAULT 'home'
    ) STRICT;
CREATE TABLE upload_confirmations (
        attempt_id TEXT PRIMARY KEY REFERENCES upload_attempts(id),
        recording_id TEXT NOT NULL REFERENCES recordings(id),
        confirm_after TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'found', 'absent')),
        checked_at TEXT
    ) STRICT;
CREATE INDEX upload_confirmations_due_idx ON upload_confirmations (status, confirm_after);
CREATE TABLE remote_uploads (
        recording_id TEXT NOT NULL REFERENCES recordings(id),
        artifact_part TEXT NOT NULL DEFAULT 'full' CHECK (artifact_part IN ('full', 'max1080p', 'nonmax1080p') OR (artifact_part GLOB 'shape[1-9]*' AND artifact_part NOT GLOB 'shape*[^0-9]*')),
        attempt_id TEXT NOT NULL,
        remote_id TEXT NOT NULL,
        remote_url TEXT NOT NULL,
        verified_at TEXT NOT NULL,
        PRIMARY KEY (recording_id, artifact_part),
        UNIQUE (attempt_id)
    ) STRICT;
CREATE TABLE upload_artifact_receipts (
        attempt_id TEXT PRIMARY KEY, recording_id TEXT NOT NULL, artifact_part TEXT NOT NULL,
        path TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL, source_path TEXT NOT NULL, metadata_json TEXT NOT NULL,
        accepted_at TEXT, verify_after TEXT, deleted_at TEXT, cleanup_error TEXT, retention_hold TEXT
    ) STRICT;
CREATE TABLE conversion_retries (
        attempt_id TEXT PRIMARY KEY, recording_id TEXT NOT NULL, artifact_part TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
CREATE TABLE local_source_presence (
        recording_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('present','missing','unavailable')),
        checked_at TEXT NOT NULL, reason TEXT
    ) STRICT;
CREATE TABLE rejected_phrases (
        provider TEXT NOT NULL,
        phrase TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        attempt_id TEXT,
        PRIMARY KEY (provider, phrase)
    ) STRICT;
CREATE TABLE provider_inventory (
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
CREATE INDEX provider_inventory_recording_idx ON provider_inventory (recording_id);
CREATE TABLE provider_inventory_syncs (
        provider TEXT PRIMARY KEY,
        completed_at TEXT NOT NULL,
        total INTEGER NOT NULL
    ) STRICT;
CREATE TABLE provider_removals (
        recording_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        remote_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        removed_at TEXT NOT NULL,
        PRIMARY KEY (recording_id, provider, remote_id)
    ) STRICT;
CREATE TABLE provider_session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        logged_in INTEGER,
        fingerprint TEXT,
        password_login_at TEXT,
        note TEXT
    ) STRICT;
CREATE INDEX provider_session_events_idx ON provider_session_events (provider, occurred_at);
CREATE TABLE worker_heartbeat (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        updated_at TEXT NOT NULL
    ) STRICT;
CREATE TABLE campaign_control (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state TEXT NOT NULL CHECK (state IN ('paused', 'running')),
        provider_filter TEXT NOT NULL,
        ordering TEXT NOT NULL CHECK (ordering = 'oldest'),
        daily_upload_limit_bytes INTEGER NOT NULL CHECK (daily_upload_limit_bytes > 0),
        antibot_failures INTEGER NOT NULL DEFAULT 0,
        resume_at TEXT,
        updated_at TEXT NOT NULL,
        trial_per_provider INTEGER CHECK (trial_per_provider > 0),
        trial_finished_at TEXT,
        attention_reason TEXT,
        upload_provider TEXT NOT NULL
    ) STRICT;
CREATE TABLE campaign_trial_recordings (
        recording_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        admitted_at TEXT NOT NULL
    ) STRICT;
CREATE TABLE comparison_trial (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        selection_json TEXT NOT NULL,
        selection_errors_json TEXT NOT NULL DEFAULT '[]',
        locked_at TEXT,
        completed_at TEXT
    ) STRICT;
CREATE TABLE upload_provider_events (
        changed_at TEXT NOT NULL,
        from_provider TEXT NOT NULL,
        to_provider TEXT NOT NULL
    ) STRICT;
CREATE TABLE retired_destination_audit (
        destination TEXT PRIMARY KEY, retired_at TEXT NOT NULL, evidence_json TEXT NOT NULL
    ) STRICT;
CREATE TABLE destinations (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('active', 'retired')),
        retirement_audit TEXT REFERENCES retired_destination_audit(destination),
        recorded_at TEXT NOT NULL
    ) STRICT;
CREATE TRIGGER campaign_control_destination_id_insert BEFORE INSERT ON campaign_control
        WHEN NOT EXISTS (SELECT 1 FROM campaign_control WHERE id = NEW.id) AND (NEW.upload_provider = 'retired' OR length(NEW.upload_provider) NOT BETWEEN 1 AND 32
        OR NEW.upload_provider GLOB '*[^a-z0-9-]*' OR substr(NEW.upload_provider, 1, 1) = '-')
        BEGIN SELECT RAISE(ABORT, 'the upload destination must be a destination ID'); END;
CREATE TRIGGER campaign_control_destination_id_update BEFORE UPDATE OF upload_provider ON campaign_control
        WHEN (NEW.upload_provider = 'retired' OR length(NEW.upload_provider) NOT BETWEEN 1 AND 32
        OR NEW.upload_provider GLOB '*[^a-z0-9-]*' OR substr(NEW.upload_provider, 1, 1) = '-')
        BEGIN SELECT RAISE(ABORT, 'the upload destination must be a destination ID'); END;
CREATE TRIGGER campaign_control_retired_destination_insert BEFORE INSERT ON campaign_control
        WHEN NOT EXISTS (SELECT 1 FROM campaign_control WHERE id = NEW.id) AND EXISTS (SELECT 1 FROM destinations WHERE id = NEW.upload_provider AND state = 'retired')
        BEGIN SELECT RAISE(ABORT, 'a retired upload destination cannot become active again'); END;
CREATE TRIGGER campaign_control_retired_destination_update BEFORE UPDATE OF upload_provider ON campaign_control
        WHEN EXISTS (SELECT 1 FROM destinations WHERE id = NEW.upload_provider AND state = 'retired')
        BEGIN SELECT RAISE(ABORT, 'a retired upload destination cannot become active again'); END;
CREATE TABLE production_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version TEXT NOT NULL,
        activated_at TEXT NOT NULL
    ) STRICT;
CREATE TABLE production_rollovers (
        id INTEGER PRIMARY KEY,
        from_version TEXT NOT NULL,
        to_version TEXT NOT NULL,
        retired_recordings INTEGER NOT NULL CHECK (retired_recordings >= 0),
        retired_remote_uploads INTEGER NOT NULL CHECK (retired_remote_uploads >= 0),
        preserved_bandwidth_bytes INTEGER NOT NULL CHECK (preserved_bandwidth_bytes >= 0),
        created_at TEXT NOT NULL
    ) STRICT;
CREATE TABLE retired_recordings (
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
CREATE TABLE retired_upload_attempts (
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
CREATE TABLE retired_remote_uploads (
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
CREATE TABLE carrier_files (
        carrier_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        recording_id TEXT NOT NULL REFERENCES recordings(id),
        artifact_part TEXT NOT NULL CHECK (artifact_part IN ('full', 'max1080p', 'nonmax1080p') OR (artifact_part GLOB 'shape[1-9]*' AND artifact_part NOT GLOB 'shape*[^0-9]*')),
        size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
        sha256 TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('copied', 'uploaded', 'removed')),
        copied_at TEXT NOT NULL,
        settled_at TEXT,
        PRIMARY KEY (carrier_id, file_name)
    ) STRICT;
CREATE INDEX carrier_files_recording_idx ON carrier_files (recording_id);
CREATE UNIQUE INDEX carrier_files_one_copy_idx ON carrier_files (recording_id) WHERE state = 'copied';
CREATE TABLE carrier_state (
        carrier_id TEXT PRIMARY KEY,
        location TEXT NOT NULL CHECK (location IN ('home', 'away', 'uplink')),
        seen_at TEXT NOT NULL,
        free_bytes INTEGER,
        in_transit_bytes INTEGER NOT NULL DEFAULT 0,
        note TEXT,
        last_notice TEXT,
        last_notice_at TEXT
    ) STRICT;
CREATE TABLE uplink_holds (
        uplink TEXT PRIMARY KEY,
        resume_at TEXT,
        reason TEXT,
        failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
        updated_at TEXT NOT NULL
    ) STRICT;
