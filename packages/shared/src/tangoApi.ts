/**
 * Tango API contract constants.
 * These are properties of the external Tango API, not our choices.
 *
 * Source of truth: the two TTL values. Everything else derives from them.
 */

/** Stream token TTL as issued by the Tango tokenData endpoint (seconds). */
export const TANGO_STREAM_TOKEN_TTL_S = 10;

/** Session token TTL as issued by the Tango session refresh endpoint (seconds). */
export const TANGO_SESSION_TOKEN_TTL_S = 60 * 60;

/** Refresh at half the TTL — tokens are always at least 50% fresh. */
export const TANGO_STREAM_TOKEN_REFRESH_MS = (TANGO_STREAM_TOKEN_TTL_S / 2) * 1000;
export const TANGO_SESSION_REFRESH_MS = (TANGO_SESSION_TOKEN_TTL_S / 2) * 1000;
