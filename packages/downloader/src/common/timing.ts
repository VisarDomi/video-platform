
// The capture loop's timings. Each site's discovery cadence and its own request timings
// belong to its plug-in (LiveCapture.pollIntervalMs).

export const STALE_STREAM_TIMEOUT_MS = 60_000;
export const QUALITY_CHECK_INTERVAL_MS = 10_000;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const NO_NEW_SEGMENTS_SLEEP_MS = 1_000;
export const POLL_WHILE_WAITING_MS = 1_000;
export const PLAYLIST_HEDGE_MS = 1_000;
export const PLAYLIST_REHEDGE_MS = 2_000;
export const PLAYLIST_MAX_REQUESTS = 15;
export const INIT_RETRY_SLEEP_MS = 1_000;
export const EDGE_RECOVERY_SLEEP_MS = 5_000;

export const SESSION_RETRY_SLEEP_MS = 5_000;
export const SEGMENT_RETRY_SLEEP_MS = 1_000;
export const RATE_LIMIT_RETRY_MS = 2_000;

// A request's own timeout, shared with the site plug-ins.
export { CDN_FETCH_TIMEOUT_MS } from "sdk";

export const ZERO_SEGMENT_COOLDOWN_MS = 20_000;

export const AUTH_LOGIN_RETRY_MS = 30_000;
export const AUTH_API_RATE_LIMIT_MS = 1_000;

export const FILE_WATCHER_DEBOUNCE_MS = 500;
export const STATUS_FILE_DEBOUNCE_MS = 200;
