import { requestSignal, type Logger } from "sdk";
import type { TsLiveConfig } from "./config.js";
import { headersForTokens, type Tokens } from "./tokens.js";

// The site's account API, on the session token the auth daemon keeps fresh: who is live
// among given accounts, profiles (names) in batches, the account's followings and follow.

// The live lookup takes at most this many accounts per request.
export const LOOKUP_BATCH = 500;
export const PROFILE_BATCH = 500;

export interface LiveStream {
    accountId: string;
    // The recording identity.
    streamId: string;
    masterUrl: string;
}

export interface LiveLookup {
    live: Map<string, LiveStream>;
    // Accounts the site reports with a stream that is not live and public (ended, private).
    notLive: Set<string>;
}

export interface Profile {
    accountId: string;
    // The current name first.
    names: string[];
}

export class TsLiveApi {
    constructor(private readonly config: TsLiveConfig, private readonly tokens: () => Promise<Tokens>, private readonly log: Logger) {}

    get baseUrl(): string {
        return this.config.baseUrl;
    }

    // The answer's JSON, or null when the site could not answer (logged; never a negative).
    private async call<T>(path: string, init: RequestInit = {}): Promise<T | null> {
        let headers: Record<string, string>;
        try {
            headers = headersForTokens(await this.tokens(), "api");
        } catch (error: any) {
            this.log.warn(`${path}: ${error.message}`);
            return null;
        }
        try {
            const response = await fetch(this.config.baseUrl + path, {
                ...init,
                headers: { ...headers, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
                signal: requestSignal(this.config.requestTimeoutMs, init.signal ?? undefined),
            });
            if (!response.ok) {
                this.log.warn(`${path} answered ${response.status}`);
                return null;
            }
            return await response.json() as T;
        } catch (error: any) {
            this.log.warn(`${path} unavailable`, { error: error?.message });
            return null;
        }
    }

    // Who is live among the accounts; null when any batch could not be read. Only the
    // site's explicit empty answer ({code: "OK", totalCount: 0}, no records) means nobody:
    // a malformed answer never ends a capture.
    async liveByAccountIds(accountIds: readonly string[]): Promise<LiveLookup | null> {
        const lookup: LiveLookup = { live: new Map(), notLive: new Set() };
        const wanted = new Set(accountIds);
        for (let start = 0; start < accountIds.length; start += LOOKUP_BATCH) {
            const batch = accountIds.slice(start, start + LOOKUP_BATCH);
            const body = await this.call<any>(`/api/live/by-account-ids?pageSize=${batch.length}`, {
                method: "POST",
                body: JSON.stringify({ accountIds: batch }),
            });
            const records = Array.isArray(body?.records) ? body.records
                : body?.code === "OK" && body.totalCount === 0 && body.records === undefined ? [] : null;
            if (records === null) {
                if (body) this.log.warn("Live lookup answered in an unexpected shape; provider state unavailable");
                return null;
            }
            for (const record of records) {
                const stream = record?.stream;
                const accountId = stream?.accountId;
                // Another account's stream, which was not asked for, is ignored.
                if (typeof accountId !== "string" || !wanted.has(accountId)) continue;
                const live = stream.status === "LIVE" && stream.kind === "PUBLIC";
                const streamId = stream.id === undefined || stream.id === null ? "" : String(stream.id);
                if (live && typeof stream.masterUrl === "string") {
                    lookup.live.set(accountId, { accountId, streamId, masterUrl: stream.masterUrl });
                } else {
                    lookup.notLive.add(accountId);
                }
            }
        }
        return lookup;
    }

    // Profiles by account ID or name; the accounts the site does not know are left out.
    // Null when the site could not answer.
    async profiles(keys: readonly string[]): Promise<Map<string, Profile> | null> {
        const found = new Map<string, Profile>();
        for (let start = 0; start < keys.length; start += PROFILE_BATCH) {
            const batch = keys.slice(start, start + PROFILE_BATCH);
            const body = await this.call<Record<string, any>>("/api/profiles/batch", { method: "POST", body: JSON.stringify(batch) });
            if (!body || typeof body !== "object") return null;
            for (const key of batch) {
                const entry = body[key];
                const accountId = entry?.accountId;
                const names = Array.isArray(entry?.profile?.aliases)
                    ? entry.profile.aliases.map((alias: any) => alias?.alias).filter((name: unknown): name is string => typeof name === "string" && name !== "")
                    : [];
                if (typeof accountId === "string" && names.length > 0) found.set(key, { accountId, names });
            }
        }
        return found;
    }

    // The accounts the signed-in account follows; null when the site could not answer.
    async followings(): Promise<string[] | null> {
        const body = await this.call<{ following?: Array<{ accountId?: unknown }> }>("/api/followings?size=5000");
        if (!Array.isArray(body?.following)) return null;
        return body.following.map((entry) => entry?.accountId).filter((id): id is string => typeof id === "string");
    }

    // Follows the account; throws when the site refused or could not answer.
    async follow(accountId: string): Promise<void> {
        const body = await this.call<{ ok?: boolean }>("/api/follow", { method: "POST", body: JSON.stringify(accountId) });
        if (body?.ok !== true) throw new Error(`Could not follow ${accountId}`);
    }
}
