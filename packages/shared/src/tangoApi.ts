/**
 * Tango API contract constants.
 * These are properties of the external Tango API, not our choices.
 * Both the auth service (writer) and the downloader (reader) must
 * agree on these values.
 */

/** Stream token TTL as issued by the Tango tokenData endpoint (seconds). */
export const TANGO_STREAM_TOKEN_TTL_S = 10;

/** Auth refresh cadence for stream tokens (ms). Must be < TTL. */
export const TANGO_STREAM_TOKEN_REFRESH_MS = 5_000;

/** Auth refresh cadence for session tokens (ms). */
export const TANGO_SESSION_REFRESH_MS = 30 * 60 * 1000;
