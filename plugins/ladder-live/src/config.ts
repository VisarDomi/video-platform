// The plug-in's block in the sites file. Every address comes from here: the plug-in
// knows the site's paths and protocol, never where the site runs.
//
//   { "id": "ladder-live", "plugin": "plugin-ladder-live",
//     "config": { "baseUrl": "http://127.0.0.1:18082", "pollIntervalMs": 10000,
//                 "latency": "middle", "maxHeight": 1080 } }

export type Latency = "low" | "high" | "middle";

export interface LadderConfig {
    // The site's origin: channel list, control API and playlists.
    baseUrl: string;
    // Discovery cadence (start to start).
    pollIntervalMs: number;
    // Wait before polling a live playlist again after it failed.
    playlistRetryMs: number;
    // The latency flavour to capture when the ladder offers several.
    latency: Latency;
    // The highest rung to capture; null = the top of the ladder.
    maxHeight: number | null;
    // A single API request's timeout.
    requestTimeoutMs: number;
}

export const DEFAULTS = {
    pollIntervalMs: 10_000,
    playlistRetryMs: 2_000,
    latency: "middle" as Latency,
    requestTimeoutMs: 10_000,
};

function positive(value: unknown, name: string, fallback: number): number {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
    return value;
}

export function readConfig(raw: Readonly<Record<string, unknown>>): LadderConfig {
    const baseUrl = raw.baseUrl;
    if (typeof baseUrl !== "string" || !/^https?:\/\//.test(baseUrl)) {
        throw new Error("config.baseUrl must be the site's http(s) origin");
    }
    const latency = raw.latency ?? DEFAULTS.latency;
    if (latency !== "low" && latency !== "high" && latency !== "middle") throw new Error('config.latency must be "low", "high" or "middle"');
    return {
        baseUrl: baseUrl.replace(/\/+$/, ""),
        pollIntervalMs: positive(raw.pollIntervalMs, "config.pollIntervalMs", DEFAULTS.pollIntervalMs),
        playlistRetryMs: positive(raw.playlistRetryMs, "config.playlistRetryMs", DEFAULTS.playlistRetryMs),
        latency,
        maxHeight: raw.maxHeight === undefined ? null : positive(raw.maxHeight, "config.maxHeight", 0),
        requestTimeoutMs: positive(raw.requestTimeoutMs, "config.requestTimeoutMs", DEFAULTS.requestTimeoutMs),
    };
}
