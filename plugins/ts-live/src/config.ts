// The plug-in's block in the sites file. Every address comes from here: the plug-in
// knows the site's paths and protocol, never where the site runs.
//
//   { "id": "ts-live", "plugin": "plugin-ts-live", "account": "demo",
//     "config": { "baseUrl": "http://127.0.0.1:18081", "pollIntervalMs": 2000 } }
//
// The account's password is not here: the auth daemon reads it from the accounts file.

export interface TsLiveConfig {
    // The site's origin: web login, API and playlists.
    baseUrl: string;
    // Who-is-live cadence, from the end of one lookup to the start of the next.
    pollIntervalMs: number;
    // Wait before polling a live playlist again after it failed. The site lists a few
    // short segments, so this stays well inside the live window.
    playlistRetryMs: number;
    // A single API request's timeout.
    requestTimeoutMs: number;
    // How often the auth daemon renews the stream tokens (they live about ten seconds)
    // and the session token (an hour).
    streamTokenRefreshMs: number;
    sessionRefreshMs: number;
    // How often the listed and followed accounts' names are read again.
    aliasRefreshIntervalMs: number;
}

export const DEFAULTS = {
    pollIntervalMs: 2_000,
    playlistRetryMs: 1_000,
    requestTimeoutMs: 10_000,
    streamTokenRefreshMs: 5_000,
    sessionRefreshMs: 30 * 60_000,
    aliasRefreshIntervalMs: 60 * 60_000,
};

function positive(value: unknown, name: string, fallback: number): number {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
    return value;
}

export function readConfig(raw: Readonly<Record<string, unknown>>): TsLiveConfig {
    const baseUrl = raw.baseUrl;
    if (typeof baseUrl !== "string" || !/^https?:\/\/[^/]+/.test(baseUrl)) {
        throw new Error("config.baseUrl must be the site's http(s) origin");
    }
    return {
        baseUrl: baseUrl.replace(/\/+$/, ""),
        pollIntervalMs: positive(raw.pollIntervalMs, "config.pollIntervalMs", DEFAULTS.pollIntervalMs),
        playlistRetryMs: positive(raw.playlistRetryMs, "config.playlistRetryMs", DEFAULTS.playlistRetryMs),
        requestTimeoutMs: positive(raw.requestTimeoutMs, "config.requestTimeoutMs", DEFAULTS.requestTimeoutMs),
        streamTokenRefreshMs: positive(raw.streamTokenRefreshMs, "config.streamTokenRefreshMs", DEFAULTS.streamTokenRefreshMs),
        sessionRefreshMs: positive(raw.sessionRefreshMs, "config.sessionRefreshMs", DEFAULTS.sessionRefreshMs),
        aliasRefreshIntervalMs: positive(raw.aliasRefreshIntervalMs, "config.aliasRefreshIntervalMs", DEFAULTS.aliasRefreshIntervalMs),
    };
}
