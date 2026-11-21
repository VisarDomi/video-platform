import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { HumanActionRequiredError, ProviderSessionLostError, requestSignal, writeFileDurably } from "sdk";
import type { ApiHostConfig } from "./config.js";

// The account's OAuth session. The refresh token lives in the destination's state folder,
// written durably before anything uses what it yields: the host rotates it at every use
// and a reused one revokes its whole family. Renewals run one at a time for the same
// reason. A power cut between the host's rotation and the durable write leaves the spent
// token on disk; its renewal is refused and the password login (this host has no second
// device to sign out) starts a new family. Access tokens live in memory only.
interface Stored {
    refreshToken: string;
    passwordLoginAt: string | null;
}

export interface TokenSource {
    readonly email: string;
    readonly password: string;
}

// The token endpoint refused the grant: the refresh token is spent, expired or revoked.
class GrantRefused extends Error {}

export class Tokens {
    private access: { token: string; expiresAt: number } | null = null;
    // Renewals and logins, one at a time.
    private queue: Promise<unknown> = Promise.resolve();
    private readonly file: string;

    constructor(
        private readonly config: ApiHostConfig,
        stateDir: string,
        private readonly credentials: () => TokenSource,
        private readonly stopSignal: AbortSignal,
        private readonly now: () => number = Date.now,
    ) {
        this.file = path.join(stateDir, "session.json");
    }

    private async stored(): Promise<Stored | null> {
        try {
            const value = JSON.parse(await readFile(this.file, "utf8")) as Partial<Stored>;
            return typeof value.refreshToken === "string" && value.refreshToken
                ? { refreshToken: value.refreshToken, passwordLoginAt: value.passwordLoginAt ?? null } : null;
        } catch (error: any) {
            if (error?.code === "ENOENT") return null;
            throw new Error(`api-host: the stored session cannot be read (${error?.message})`);
        }
    }

    private async grant(fields: Record<string, string>): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
        const response = await fetch(`${this.config.baseUrl}/oauth/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body: new URLSearchParams({ ...fields, client_id: this.config.clientId, client_secret: this.config.clientSecret }),
            signal: requestSignal(this.config.requestTimeoutMs, this.stopSignal),
        });
        const body = await response.json().catch(() => null) as Record<string, unknown> | null;
        if (response.ok && typeof body?.access_token === "string" && typeof body.expires_in === "number") {
            return body as { access_token: string; expires_in: number; refresh_token?: string };
        }
        if (response.status === 401 && body?.error === "invalid_client") {
            throw new HumanActionRequiredError("session_login", "api-host refused the client ID or secret in the sites file");
        }
        if (response.status === 400 && body?.error === "invalid_grant") throw new GrantRefused(String(body.error_description ?? "invalid_grant"));
        // A server error, a rate limit or a reset: a passing problem, never a reason to sign in.
        throw new Error(`api-host: the token endpoint answered ${response.status}`);
    }

    // A fresh access token from the stored refresh token; the rotated refresh token is saved
    // before the access token is used. Null when there is no session to renew.
    private async renew(): Promise<string | null> {
        const stored = await this.stored();
        if (!stored) return null;
        let answer;
        try {
            answer = await this.grant({ grant_type: "refresh_token", refresh_token: stored.refreshToken });
        } catch (error) {
            if (error instanceof GrantRefused) return null;
            throw error;
        }
        if (answer.refresh_token && answer.refresh_token !== stored.refreshToken) {
            await writeFileDurably(this.file, JSON.stringify({ ...stored, refreshToken: answer.refresh_token }) + "\n");
        }
        this.access = { token: answer.access_token, expiresAt: this.now() + answer.expires_in * 1000 };
        return answer.access_token;
    }

    private async passwordLogin(): Promise<string> {
        const { email, password } = this.credentials();
        let answer;
        try {
            answer = await this.grant({ grant_type: "password", username: email, password });
        } catch (error) {
            if (error instanceof GrantRefused) throw new HumanActionRequiredError("session_login", "api-host refused the account's password");
            throw error;
        }
        if (!answer.refresh_token) throw new Error("api-host: the password login answered without a refresh token");
        await writeFileDurably(this.file, JSON.stringify({ refreshToken: answer.refresh_token, passwordLoginAt: new Date(this.now()).toISOString() }) + "\n");
        this.access = { token: answer.access_token, expiresAt: this.now() + answer.expires_in * 1000 };
        return answer.access_token;
    }

    // An access token for the next request: the one in memory while it has a minute left,
    // else a renewal, else (when allowed) a password login.
    private exclusive<T>(run: () => Promise<T>): Promise<T> {
        const next = this.queue.catch(() => {}).then(run);
        this.queue = next;
        return next;
    }

    async bearer(): Promise<string> {
        const usable = () => this.access && this.access.expiresAt - this.now() > 60_000 ? this.access.token : null;
        return usable() ?? this.exclusive(async () => {
            const current = usable();
            if (current) return current;
            this.access = null;
            const renewed = await this.renew();
            if (renewed) return renewed;
            if (!this.config.allowPasswordLogin) throw new ProviderSessionLostError(`api-host is signed out; ${this.lostAdvice}`);
            return this.passwordLogin();
        });
    }

    // The API answered 401: the access token in memory is no good any more.
    forget(): void {
        this.access = null;
    }

    get lostAdvice(): string {
        return this.config.allowPasswordLogin
            ? "the next upload signs api-host in again with the account's password"
            : "sign api-host in again (password logins are off for it)";
    }

    // One renewal says whether the stored login still works. Network and server errors
    // throw: they say nothing about the login.
    check(): Promise<{ loggedIn: boolean; fingerprint: string | null; passwordLoginAt: string | null; note: string }> {
        return this.exclusive(() => this.checkNow());
    }

    private async checkNow(): Promise<{ loggedIn: boolean; fingerprint: string | null; passwordLoginAt: string | null; note: string }> {
        const stored = await this.stored();
        if (!stored) return { loggedIn: false, fingerprint: null, passwordLoginAt: null, note: "no stored session" };
        const loggedIn = (await this.renew()) !== null;
        // The family part of "rt.<family>.<generation>.<mac>" names the login across rotations.
        const family = stored.refreshToken.split(".")[1] ?? stored.refreshToken;
        return {
            loggedIn,
            fingerprint: createHash("sha256").update(family).digest("hex").slice(0, 12),
            passwordLoginAt: stored.passwordLoginAt,
            note: loggedIn ? "the refresh token was renewed" : "the token endpoint refused the refresh token",
        };
    }
}
