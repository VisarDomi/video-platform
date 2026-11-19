// The plug-in's block in the sites file. Every address and secret comes from here: the
// plug-in knows the site's paths and protocol, never where the site runs.
//
//   { "id": "fmp4-live", "plugin": "plugin-fmp4-live",
//     "config": { "baseUrl": "http://127.0.0.1:18083",
//                 "playlistKeys": { "k1": "<secret>" }, "pollIntervalMs": 5000 } }

export interface Fmp4Config {
    // The site's origin: the status, stream and name APIs. Edge addresses come from the
    // stream API.
    baseUrl: string;
    // Secrets for the obfuscated playlists, by the key ID a playlist names.
    playlistKeys: Record<string, string>;
    // Discovery cadence (end of one poll to the start of the next).
    pollIntervalMs: number;
    // Wait before polling a live playlist again after it and its copies failed.
    playlistRetryMs: number;
    // How long a failure keeps an edge at the back of the failover order.
    edgeFailureMemoryMs: number;
    // A single API request's timeout.
    requestTimeoutMs: number;
}

export const DEFAULTS = {
    pollIntervalMs: 5_000,
    playlistRetryMs: 1_000,
    edgeFailureMemoryMs: 60_000,
    requestTimeoutMs: 10_000,
};

function positive(value: unknown, name: string, fallback: number): number {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
    return value;
}

export function readConfig(raw: Readonly<Record<string, unknown>>): Fmp4Config {
    const baseUrl = raw.baseUrl;
    if (typeof baseUrl !== "string" || !/^https?:\/\//.test(baseUrl)) {
        throw new Error("config.baseUrl must be the site's http(s) origin");
    }
    const keys = raw.playlistKeys ?? {};
    if (typeof keys !== "object" || keys === null || Array.isArray(keys)
        || Object.values(keys).some((secret) => typeof secret !== "string" || secret === "")) {
        throw new Error("config.playlistKeys must map key IDs to secrets");
    }
    return {
        baseUrl: baseUrl.replace(/\/+$/, ""),
        playlistKeys: { ...(keys as Record<string, string>) },
        pollIntervalMs: positive(raw.pollIntervalMs, "config.pollIntervalMs", DEFAULTS.pollIntervalMs),
        playlistRetryMs: positive(raw.playlistRetryMs, "config.playlistRetryMs", DEFAULTS.playlistRetryMs),
        edgeFailureMemoryMs: positive(raw.edgeFailureMemoryMs, "config.edgeFailureMemoryMs", DEFAULTS.edgeFailureMemoryMs),
        requestTimeoutMs: positive(raw.requestTimeoutMs, "config.requestTimeoutMs", DEFAULTS.requestTimeoutMs),
    };
}
