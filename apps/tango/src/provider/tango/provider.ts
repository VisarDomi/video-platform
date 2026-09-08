import { Handler, type Provider, type Route, type Stream } from "../types";

const GATEWAY = "https://gateway.tango.me";
const PUBLIC = `${GATEWAY}/proxycador/api/public/v1`;
const DOWNLOADS = "https://192.168.1.197:9999/api/tango";

interface XhrResult {
    status: number;
    text: string;
}

function request(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<XhrResult> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(init.method ?? "GET", url);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json; charset=UTF-8");
        for (const [name, value] of Object.entries(init.headers ?? {})) {
            xhr.setRequestHeader(name, value);
        }
        xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
        xhr.onerror = () => reject(new Error(`Request failed: ${url}`));
        xhr.send(init.body ?? null);
    });
}

async function ok(url: string, init?: Parameters<typeof request>[1]): Promise<XhrResult> {
    const response = await request(url, init);
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`${url} returned ${response.status}`);
    }
    return response;
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${label} is not an object`);
    }
    return value as Record<string, unknown>;
}

function requiredStringArray(value: unknown, label: string): string[] {
    if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
        throw new Error(`${label} is not a string array`);
    }
    return value;
}

async function bestEffort<T>(label: string, fallback: T, operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        console.warn(`${label} failed`, error);
        return fallback;
    }
}

async function requireDownloadUpdate(response: Response, action: string): Promise<void> {
    if (!response.ok) throw new Error(`Download-list ${action} failed: ${response.status}`);
    const body = requiredObject(await response.json() as unknown, `Download-list ${action} response`);
    if (body.success !== true) throw new Error(`Download-list ${action} was not confirmed`);
}

function nativeSession(): { accountId: string; sessionId: string } {
    let accountId = localStorage.getItem("latest_account_id") ?? "";
    let sessionId = sessionStorage.getItem("username") ?? "";

    if (!accountId) {
        const raw = localStorage.getItem("persist:production:user");
        if (raw !== null) {
            const value = JSON.parse(raw) as unknown;
            if (typeof value !== "object" || value === null) throw new Error("Tango's stored user is not an object");
            const persisted = value as { accountId?: unknown };
            if (persisted.accountId !== undefined) {
                if (typeof persisted.accountId !== "string") throw new Error("Tango's stored account ID is invalid");
                const parsed = JSON.parse(persisted.accountId) as unknown;
                if (typeof parsed !== "string") throw new Error("Tango's stored account ID is invalid");
                accountId = parsed;
            }
        }
    }
    if (!sessionId) {
        const raw = localStorage.getItem("persist:production:sessionDetails");
        if (raw !== null) {
            const value = JSON.parse(raw) as unknown;
            if (typeof value !== "object" || value === null) throw new Error("Tango's stored session is not an object");
            const persisted = value as { data?: unknown };
            if (persisted.data !== undefined) {
                if (typeof persisted.data !== "string") throw new Error("Tango's stored session details are invalid");
                const details = JSON.parse(persisted.data) as unknown;
                if (typeof details !== "object" || details === null) throw new Error("Tango's stored session details are invalid");
                const candidate = (details as { sessionId?: unknown }).sessionId;
                if (candidate !== undefined && typeof candidate !== "string") {
                    throw new Error("Tango's stored session ID is invalid");
                }
                sessionId = candidate ?? "";
            }
        }
    }
    if (!accountId || !sessionId) throw new Error("Log in to Tango, then refresh this page.");
    return { accountId, sessionId };
}

function recordToStream(record: any, isFollowing: boolean): Stream | null {
    const streamerId = record.anchor?.encryptedAccountId ?? record.stream?.encryptedAccountId;
    const streamId = record.stream?.id;
    const masterListUrl = record.stream?.masterListUrl;
    const publicStream = record.isPublic === true || record.stream?.streamKind === "PUBLIC";
    if (!streamerId || !streamId || !masterListUrl || record.stream?.status !== "LIVING" || !publicStream) return null;
    return {
        streamerId,
        streamId,
        masterListUrl,
        firstName: record.anchor?.firstName ?? streamerId,
        alias: record.anchor?.aliases?.[0]?.alias,
        isFollowing,
    };
}

async function recommendator(path: string, isFollowing: boolean): Promise<Stream[]> {
    const response = await ok(`${GATEWAY}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
    });
    const body = requiredObject(JSON.parse(response.text) as unknown, "Tango recommendation response");
    if (!Array.isArray(body.records)) throw new Error("Tango recommendation records are not an array");
    return body.records
        .map(record => recordToStream(record, isFollowing))
        .filter((stream): stream is Stream => stream !== null);
}

async function fetchBlocked(): Promise<Set<string>> {
    const response = await ok(`${GATEWAY}/abregistrar/connection/v1/blocklist`);
    const body = JSON.parse(response.text) as unknown;
    if (Array.isArray(body)) return new Set(requiredStringArray(body, "Tango blocklist"));
    const object = requiredObject(body, "Tango blocklist response");
    return new Set(requiredStringArray(object.users, "Tango blocklist users"));
}

function dedupe(streams: Stream[]): Stream[] {
    const result = new Map<string, Stream>();
    for (const stream of streams) {
        const previous = result.get(stream.streamerId);
        if (!previous || stream.isFollowing) result.set(stream.streamerId, stream);
    }
    return [...result.values()];
}

async function enrichAll(streams: Stream[]): Promise<Stream[]> {
    if (!streams.length) return streams;
    return bestEffort("Tango batch profile enrichment", streams, async () => {
        const response = await ok(`${GATEWAY}/proxycador/api/public/v1/profiles/v2/batch?basicProfile=true&liveStats=false&followStats=false`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(streams.map(stream => stream.streamerId)),
        });
        const profiles = JSON.parse(response.text) as Record<string, { basicProfile?: { aliases?: { alias?: string }[]; firstName?: string } }>;
        return streams.map(stream => {
            const profile = profiles[stream.streamerId]?.basicProfile;
            return {
                ...stream,
                alias: profile?.aliases?.[0]?.alias ?? stream.alias,
                firstName: profile?.firstName ?? stream.firstName,
            };
        });
    });
}

async function refreshSession(): Promise<void> {
    const session = nativeSession();
    await ok(`${GATEWAY}/session-service/public/v2/session/web/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(session),
    });
}

async function refreshStreamTokens(): Promise<void> {
    await ok(`${PUBLIC}/live/stream/v1/tokenData`);
}

export const tango: Provider = {
    matchRoute(pathname: string): Route {
        const match = pathname.match(/^\/stream\/([^/]+)/);
        return match
            ? { handler: Handler.Stream, streamId: decodeURIComponent(match[1]) }
            : { handler: Handler.Home };
    },

    streamUrl(streamId: string): string {
        return `/stream/${encodeURIComponent(streamId)}`;
    },

    async startAuthentication(): Promise<void> {
        await refreshSession();
        await refreshStreamTokens();
        // These belong to this document, including its bfcache lifetime.
        window.setInterval(() => void refreshStreamTokens(), 5_000);
        window.setInterval(() => void refreshSession(), 30 * 60_000);
        addEventListener("pageshow", () => void refreshStreamTokens());
    },

    async fetchStreams(): Promise<Stream[]> {
        const [blocked, followed, recommended] = await Promise.all([
            fetchBlocked(),
            recommendator("/recommendator/social/v2/list/following?includeAlias=true", true),
            recommendator("/recommendator/social/v2/list/following_recommendations", false),
        ]);
        return dedupe([...followed, ...recommended]).filter(stream => !blocked.has(stream.streamerId));
    },

    async fetchCostreamers(stream: Stream): Promise<Stream[]> {
        const [response, blocked] = await Promise.all([
            ok(`${PUBLIC}/live/stream/v2/watch?requestId=${crypto.randomUUID()}`, {
                method: "POST",
                body: stream.streamId,
            }),
            fetchBlocked(),
        ]);
        const body = requiredObject(JSON.parse(response.text) as unknown, "Tango watch response");
        const multiBroadcast = body.multiBroadcast;
        if (multiBroadcast === undefined || multiBroadcast === null) return [];
        const multiBroadcastObject = requiredObject(multiBroadcast, "Tango multi-broadcast data");
        if (!Array.isArray(multiBroadcastObject.streams)) {
            throw new Error("Tango multi-broadcast streams are not an array");
        }
        const items = multiBroadcastObject.streams as any[];
        const streams: Stream[] = [];
        for (const item of items) {
            const descriptor = item.stream?.mbDescriptor;
            if (!descriptor?.accountId || !descriptor.streamId || !item.stream?.streamURL) continue;
            if (descriptor.accountId === stream.streamerId) continue;
            if (blocked.has(descriptor.accountId)) continue;
            streams.push({
                streamerId: descriptor.accountId,
                streamId: descriptor.streamId,
                masterListUrl: item.stream.streamURL,
                firstName: descriptor.accountId,
                isFollowing: false,
                parentStreamerId: stream.streamerId,
            });
        }
        return streams;
    },

    enrichAll,

    async enrich(stream: Stream): Promise<Stream> {
        return bestEffort("Tango profile enrichment", stream, async () => {
            const response = await ok(`${GATEWAY}/proxycador/api/profiles/v2/single?id=${encodeURIComponent(stream.streamerId)}&basicProfile=true&liveStats=false&followStats=false`);
            const profile = JSON.parse(response.text).basicProfile;
            return {
                ...stream,
                alias: profile?.aliases?.[0]?.alias ?? stream.alias,
                firstName: profile?.firstName ?? stream.firstName,
            };
        });
    },

    async follow(streamerId: string): Promise<void> {
        await ok(`${PUBLIC}/follow/add`, { method: "POST", body: streamerId });
    },

    async unfollow(streamerId: string): Promise<void> {
        await ok(`${PUBLIC}/follow/remove`, { method: "POST", body: streamerId });
    },

    async block(streamerId: string): Promise<void> {
        const response = await ok(`${GATEWAY}/abregistrar/connection/v1/blocklist`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "BLOCK", account_id: [streamerId] }),
        });
        const result = JSON.parse(response.text) as { error_code?: number; error_message?: string };
        if (result.error_code !== 0) throw new Error(result.error_message || "Tango did not block this streamer.");
    },

    async fetchDownloadList(): Promise<Set<string>> {
        const response = await fetch(`${DOWNLOADS}/list`);
        if (!response.ok) throw new Error(`Download-list request failed: ${response.status}`);
        const body = await response.json() as unknown;
        return new Set(requiredStringArray(body, "Download-list response"));
    },

    async addToDownloadList(streamerId: string): Promise<void> {
        const response = await fetch(`${DOWNLOADS}/add`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ identifier: streamerId }),
        });
        await requireDownloadUpdate(response, "add");
    },

    async removeFromDownloadList(streamerId: string): Promise<void> {
        const response = await fetch(`${DOWNLOADS}/remove`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ identifier: streamerId }),
        });
        await requireDownloadUpdate(response, "remove");
    },
};
