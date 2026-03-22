/**
 * Timing constants — executive decisions.
 * Every value here was chosen deliberately. Change with care.
 */

// Discovery poll cadence
export const TANGO_POLL_MS = 1_000;
export const SC_POLL_MS = 5_000;
export const FC2_POLL_MS = 1_000;

// Download loop
export const STALE_STREAM_TIMEOUT_MS = 60_000;
export const QUALITY_CHECK_INTERVAL_MS = 10_000;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const NO_NEW_SEGMENTS_SLEEP_MS = 1_000;
export const INIT_RETRY_SLEEP_MS = 1_000;
export const EDGE_RECOVERY_SLEEP_MS = 5_000;

// Session retry
export const SESSION_RETRY_SLEEP_MS = 5_000;

// CDN fetch timeout (all providers)
export const CDN_FETCH_TIMEOUT_MS = 30_000;

// Retry cooldown after 0-segment download
export const ZERO_SEGMENT_COOLDOWN_MS = 20_000;

// Orphan finalizer
export const ORPHAN_SECOND_CHECK_MS = 5 * 60 * 1_000;
export const ORPHAN_CYCLE_MS = 24 * 60 * 60 * 1_000;
export const ORPHAN_MIN_AGE_MS = 60 * 60 * 1_000;

// Disk space monitor
export const DISK_CHECK_INTERVAL_MS = 60_000;
export const DISK_FULL_SLEEP_MS = 24 * 60 * 60 * 1_000;

// Auth
export const AUTH_LOGIN_RETRY_MS = 30_000;
export const AUTH_API_RATE_LIMIT_MS = 1_000;

// File system debounce
export const FILE_WATCHER_DEBOUNCE_MS = 500;
export const STATUS_FILE_DEBOUNCE_MS = 200;
