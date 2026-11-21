import type { CredentialSource, StoredCredentials, TokenBag } from "sdk";

// The account's session as the core's credential store keeps it. The record's field names
// are a contract between the auth side (which writes it) and every reader (capture,
// catalog): renaming one turns every request into a 401.
//
//   { refreshToken, sessionToken, deviceId, streamToken, streamAccount, streamExpires }
//
// The refresh token rotates at every renewal; the session token authorizes the API; the
// stream tokens (about ten seconds) authorize the playlists. Segments need none.
export interface TsLiveRecord {
    refreshToken: string;
    sessionToken: string | null;
    deviceId: string | null;
    streamToken: string | null;
    streamAccount: string | null;
    streamExpires: string | null;
}

export interface Tokens {
    session: string | null;
    streamToken: string | null;
    streamAccount: string | null;
    // Epoch seconds, as the site sets it.
    streamExpires: string | null;
    readAtMs: number;
    // Seconds the stream tokens had left when read; null without them.
    ttlAtReadSec: number | null;
}

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

export function recordOf(bag: TokenBag): TsLiveRecord {
    return {
        refreshToken: bag.refreshToken,
        sessionToken: bag.sessionToken,
        deviceId: bag.extras.deviceId ?? null,
        streamToken: bag.extras.streamToken ?? null,
        streamAccount: bag.extras.streamAccount ?? null,
        streamExpires: bag.extras.streamExpires ?? null,
    };
}

export function bagOf(record: Record<string, unknown>): TokenBag | null {
    const refreshToken = text(record.refreshToken);
    if (!refreshToken) return null;
    return {
        refreshToken,
        sessionToken: text(record.sessionToken),
        extras: {
            deviceId: text(record.deviceId),
            streamToken: text(record.streamToken),
            streamAccount: text(record.streamAccount),
            streamExpires: text(record.streamExpires),
        },
    };
}

// Without the session token nothing is used, not even the stream tokens.
export function tokensFromCredentials(stored: StoredCredentials): Tokens {
    const { readAtMs } = stored;
    const record = stored.record ?? {};
    const session = text(record.sessionToken);
    if (!session) return { session: null, streamToken: null, streamAccount: null, streamExpires: null, readAtMs, ttlAtReadSec: null };
    const streamExpires = text(record.streamExpires);
    const expires = streamExpires === null ? NaN : Number(streamExpires);
    return {
        session,
        streamToken: text(record.streamToken),
        streamAccount: text(record.streamAccount),
        streamExpires,
        readAtMs,
        ttlAtReadSec: Number.isFinite(expires) ? expires - Math.floor(readAtMs / 1000) : null,
    };
}

// Reads the store on every call: the auth daemon replaces the stream tokens every few
// seconds.
export function tokenReader(credentials: CredentialSource): () => Promise<Tokens> {
    return async () => tokensFromCredentials(await credentials.read());
}

// The request headers: the API takes the session token, the playlists the stream tokens.
// Throws when the tokens lack what the request needs.
export function headersForTokens(tokens: Tokens, kind: "api" | "stream"): Record<string, string> {
    if (kind === "api") {
        if (!tokens.session) throw new Error("No session token: the account is not signed in");
        return { cookie: `session_token=${tokens.session}`, accept: "application/json" };
    }
    if (!tokens.streamToken || !tokens.streamAccount || !tokens.streamExpires) {
        throw new Error("No stream tokens: the auth daemon has not fetched them yet");
    }
    return { cookie: `stream_token=${tokens.streamToken}; stream_account=${tokens.streamAccount}; stream_expires=${tokens.streamExpires}` };
}

// The claims of a JWT-shaped token, unverified (the site verifies them); null when it is
// not one.
export function claimsOf(token: string | null): Record<string, unknown> | null {
    const body = token?.split(".")[1];
    if (!body) return null;
    try {
        const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
        return claims && typeof claims === "object" && !Array.isArray(claims) ? claims : null;
    } catch {
        return null;
    }
}

// The value of a cookie in a response's Set-Cookie headers, or null.
export function cookieValue(setCookies: readonly string[], name: string): string | null {
    for (const line of setCookies) {
        const [pair] = line.split(";");
        const at = pair.indexOf("=");
        if (at > 0 && pair.slice(0, at).trim() === name) return decodeURIComponent(pair.slice(at + 1).trim());
    }
    return null;
}
