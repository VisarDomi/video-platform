import {
    requestSignal,
    type AuthDecision,
    type Clock,
    type Logger,
    type SessionRenewal,
    type ShortTokens,
    type SiteAccount,
    type SiteAuth,
    type StoredCredentials,
    type TokenBag,
} from "sdk";
import type { TsLiveConfig } from "./config.js";
import { bagOf, claimsOf, cookieValue, headersForTokens, recordOf, tokensFromCredentials } from "./tokens.js";

// The site refused the account's username or password. Signing in again cannot help: a
// person has to fix the accounts file.
export class SignInRefused extends Error {}
// The site rejected the stored session (an invalid, expired, reused or revoked token, or a
// sign-in the site cannot place). A fresh sign-in starts a new token family.
export class SessionRejected extends Error {
    constructor(message: string, readonly errorCode: string) { super(message); }
}
// The site asked for its device check, which a fresh sign-in passes.
export class ChallengeRequired extends Error {}

interface SiteError { errorCode?: unknown }

// The account's sessions on the site. A sign-in (the web form, as JSON) starts a token
// family: a rotating refresh token, the session token it yields and the device cookie the
// renewals must present. The auth daemon renews the session every half hour and the
// stream tokens every five seconds, and saves the bag to the core's credential store,
// where capture and catalog read it. A phone gets a family of its own (provisionDevice):
// the PC hands it over once and never uses it.
export class TsLiveAuth implements SiteAuth {
    readonly intervals: SiteAuth["intervals"];

    // clock: the host's, so a site whose time is not the wall clock's (a simulation) is judged
    // by its own.
    constructor(private readonly config: TsLiveConfig, private readonly log?: Logger, private readonly clock: Clock = Date) {
        this.intervals = { shortTokenRefresh: config.streamTokenRefreshMs, sessionRefresh: config.sessionRefreshMs };
    }

    private request(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
        const { timeoutMs = this.config.requestTimeoutMs, ...rest } = init;
        return fetch(this.config.baseUrl + path, { ...rest, redirect: "manual", signal: requestSignal(timeoutMs, rest.signal ?? undefined) });
    }

    // A failed answer as an error the classifier understands. A client error with the
    // site's own error code rejects the session; a page without one (a block page) or a
    // server error says nothing about it, so the tokens stay good.
    private async failure(response: Response, what: string): Promise<Error> {
        const body = await response.json().catch(() => null) as SiteError | null;
        const code = typeof body?.errorCode === "string" ? body.errorCode : null;
        if (response.status === 424 && code === "CHALLENGE_REQUIRED") return new ChallengeRequired(`${what}: the site asked for its device check`);
        if (code && response.status >= 400 && response.status < 500) return new SessionRejected(`${what} rejected (HTTP ${response.status} ${code})`, code);
        return new Error(`${what} unavailable (HTTP ${response.status})`);
    }

    async login(account: SiteAccount): Promise<TokenBag> {
        const response = await this.request("/login", {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ username: account.email, password: account.password }),
        });
        if (response.status === 401) {
            const body = await response.json().catch(() => null) as SiteError | null;
            if (body?.errorCode === "BAD_CREDENTIALS") throw new SignInRefused(`The site refused the sign-in of ${account.email}`);
        }
        if (!response.ok) throw await this.failure(response, "Sign-in");
        const cookies = response.headers.getSetCookie();
        const refreshToken = cookieValue(cookies, "refresh_token");
        const sessionToken = cookieValue(cookies, "session_token");
        const deviceId = cookieValue(cookies, "device_id");
        if (!refreshToken || !sessionToken || !deviceId) throw new Error("Sign-in answered without its session cookies");
        return { refreshToken, sessionToken, extras: { deviceId, streamToken: null, streamAccount: null, streamExpires: null } };
    }

    // Rotates the refresh token: the presented one is spent, whatever happens next, so the
    // new one must reach the store before anything else uses the bag (the auth daemon
    // saves the renewal before it continues).
    async refreshSession(bag: TokenBag): Promise<SessionRenewal> {
        const claims = claimsOf(bag.refreshToken);
        const accountId = claims?.sub;
        const sessionId = claims?.sid;
        if (typeof accountId !== "string" || typeof sessionId !== "string") {
            throw new SessionRejected("The stored refresh token names no account or session", "INVALID_TOKEN");
        }
        const response = await this.request("/api/session/refresh", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                accept: "application/json",
                cookie: `refresh_token=${bag.refreshToken}; device_id=${bag.extras.deviceId ?? ""}`,
            },
            body: JSON.stringify({ accountId, sessionId }),
        });
        if (!response.ok) throw await this.failure(response, "Session renewal");
        const cookies = response.headers.getSetCookie();
        const newSessionToken = cookieValue(cookies, "session_token");
        if (!newSessionToken) throw new Error("Session renewal answered without a session token");
        return { newSessionToken, newRefreshToken: cookieValue(cookies, "refresh_token") };
    }

    async fetchShortTokens(bag: TokenBag, timeoutMs: number): Promise<ShortTokens> {
        if (!bag.sessionToken) throw new SessionRejected("No session token to trade for stream tokens", "INVALID_TOKEN");
        const response = await this.request("/api/stream/token", {
            headers: { accept: "application/json", cookie: `session_token=${bag.sessionToken}` },
            timeoutMs,
        });
        if (!response.ok) throw await this.failure(response, "Stream tokens");
        const cookies = response.headers.getSetCookie();
        const streamToken = cookieValue(cookies, "stream_token");
        const streamAccount = cookieValue(cookies, "stream_account");
        const streamExpires = cookieValue(cookies, "stream_expires");
        if (!streamToken || !streamAccount || !streamExpires) throw new Error("Stream tokens answered without its cookies");
        const ttl = Number(streamExpires) - Math.floor(this.clock.now() / 1000);
        if (!(ttl > 0)) this.log?.warn(`The site issued stream tokens that have already expired (expires=${streamExpires})`);
        return { extras: { streamToken, streamAccount, streamExpires } };
    }

    classify(error: unknown): AuthDecision {
        if (error instanceof SignInRefused) return "needs-attention";
        if (error instanceof ChallengeRequired) return "verification";
        if (error instanceof SessionRejected) return "reauthenticate";
        return "outage";
    }

    serializeTokens(bag: TokenBag): Record<string, unknown> {
        return { ...recordOf(bag) };
    }

    deserializeTokens(record: Record<string, unknown>): TokenBag | null {
        return bagOf(record);
    }

    headersFor(credentials: StoredCredentials, kind: "api" | "stream"): Record<string, string> {
        return headersForTokens(tokensFromCredentials(credentials), kind);
    }

    describeTokens(bag: TokenBag): { sessionExpiresAt?: number; shortExpiresAt?: number; summary: string } {
        const exp = claimsOf(bag.sessionToken)?.exp;
        const streamExpires = Number(bag.extras.streamExpires);
        return {
            ...(typeof exp === "number" ? { sessionExpiresAt: exp * 1000 } : {}),
            ...(Number.isFinite(streamExpires) && bag.extras.streamExpires ? { shortExpiresAt: streamExpires * 1000 } : {}),
            summary: `stream_expires=${bag.extras.streamExpires ?? "none"}`,
        };
    }

    // The phone's own token family. A sign-in authorizes the request; the site hands out
    // the phone's tokens once per request ID (the same ones again until the phone
    // acknowledges them), and the PC keeps none of them.
    async provisionDevice(account: SiteAccount, requestId: string): Promise<{ cookies: unknown[] }> {
        const authorizing = await this.login(account);
        const response = await this.request("/api/device/provision", {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json", cookie: `session_token=${authorizing.sessionToken}` },
            body: JSON.stringify({ requestId }),
        });
        if (!response.ok) throw await this.failure(response, "Device provisioning");
        const body = await response.json() as { refreshToken?: unknown; sessionToken?: unknown; deviceId?: unknown };
        if (typeof body.refreshToken !== "string" || typeof body.sessionToken !== "string" || typeof body.deviceId !== "string") {
            throw new Error("Device provisioning answered without the phone's tokens");
        }
        const { hostname, protocol } = new URL(this.config.baseUrl);
        const cookie = (name: string, value: string, httpOnly: boolean, expires: unknown) => ({
            name, value, domain: hostname, path: "/", httpOnly, secure: protocol === "https:", sameSite: "Lax",
            expires: typeof expires === "number" ? expires : -1,
        });
        const refreshExpires = claimsOf(body.refreshToken)?.exp;
        return { cookies: [
            cookie("refresh_token", body.refreshToken, true, refreshExpires),
            cookie("session_token", body.sessionToken, false, claimsOf(body.sessionToken)?.exp),
            cookie("device_id", body.deviceId, true, refreshExpires),
        ] };
    }

    async acknowledgeDevice(requestId: string): Promise<void> {
        const response = await this.request("/api/device/acknowledge", {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ requestId }),
        });
        if (!response.ok) throw await this.failure(response, "Device acknowledgement");
    }
}
