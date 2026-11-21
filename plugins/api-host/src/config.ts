// The destination's block in the sites file:
//   { "id": "api-host", "plugin": "plugin-api-host",
//     "config": { "baseUrl": "http://127.0.0.1:18086", "clientId": "pipeline", "clientSecret": "<secret>" } }
// The account's username and password come from the credentials file, never from here.
export interface ApiHostConfig {
    readonly baseUrl: string;
    // The OAuth client the account's tokens are issued to.
    readonly clientId: string;
    readonly clientSecret: string;
    // The category every upload is filed under (none: the host's default).
    readonly categoryId: string | null;
    // Bytes per upload request: a multiple of the host's 256 KiB granularity.
    readonly chunkBytes: number;
    // Requests in a row that move the upload no further before the transfer stops.
    readonly chunkAttempts: number;
    readonly retryDelayMs: number;
    readonly requestTimeoutMs: number;
    // Sign in with the account's password when no session is left (default: yes; this
    // host has no second device whose login a password login would end).
    readonly allowPasswordLogin: boolean;
}

const GRANULARITY = 256 * 1024;

export function readConfig(raw: Readonly<Record<string, unknown>>): ApiHostConfig {
    const baseUrl = raw.baseUrl;
    if (typeof baseUrl !== "string" || !/^https?:\/\/[^/]+/.test(baseUrl)) throw new Error("api-host: config.baseUrl must be an http(s) origin");
    const text = (name: string): string => {
        const value = raw[name];
        if (typeof value !== "string" || !value) throw new Error(`api-host: config.${name} is required`);
        return value;
    };
    const count = (name: string, fallback: number, minimum: number): number => {
        const value = raw[name] ?? fallback;
        if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) throw new Error(`api-host: config.${name} must be an integer of at least ${minimum}`);
        return value;
    };
    const chunkBytes = count("chunkBytes", 32 * GRANULARITY, GRANULARITY);
    if (chunkBytes % GRANULARITY !== 0) throw new Error("api-host: config.chunkBytes must be a multiple of 262144");
    const categoryId = raw.categoryId ?? null;
    if (categoryId !== null && (typeof categoryId !== "string" || !/^\d+$/.test(categoryId))) throw new Error("api-host: config.categoryId must be a numeric ID");
    const allowPasswordLogin = raw.allowPasswordLogin ?? true;
    if (typeof allowPasswordLogin !== "boolean") throw new Error("api-host: config.allowPasswordLogin must be true or false");
    return {
        baseUrl: baseUrl.replace(/\/+$/, ""), clientId: text("clientId"), clientSecret: text("clientSecret"), categoryId, chunkBytes,
        chunkAttempts: count("chunkAttempts", 5, 1), retryDelayMs: count("retryDelayMs", 1000, 0),
        requestTimeoutMs: count("requestTimeoutMs", 60_000, 1000), allowPasswordLogin,
    };
}
