import { Handler, type Provider, type Route, type Stream } from "../types";

const GATEWAY = "https://gateway.tango.me";
const PUBLIC = `${GATEWAY}/proxycador/api/public/v1`;
const DOWNLOADS = "https://192.168.1.197:7973/api/tango";

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

function nativeSession(): { accountId: string; sessionId: string } {
    let accountId = localStorage.getItem("latest_account_id") ?? "";
    let sessionId = sessionStorage.getItem("username") ?? "";

    if (!accountId) {
        try {
            const persisted = JSON.parse(localStorage.getItem("persist:production:user") ?? "{}") as { accountId?: string };
            accountId = persisted.accountId ? JSON.parse(persisted.accountId) as string : "";
        } catch { /* Tango changed its persisted state. */ }
    }
    if (!sessionId) {
        try {
            const persisted = JSON.parse(localStorage.getItem("persist:production:sessionDetails") ?? "{}") as { data?: string };
            const details = JSON.parse(persisted.data ?? "{}") as { sessionId?: string };
            sessionId = details.sessionId ?? "";
        } catch { /* Tango changed its persisted state. */ }
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
    const body = JSON.parse(response.text) as { records?: any[] };
    return (body.records ?? [])
        .map(record => recordToStream(record, isFollowing))
        .filter((stream): stream is Stream => stream !== null);
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
    try {
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
    } catch {
        return streams;
    }
}

async function refreshSession(): Promise<void> {
    const session = nativeSession();
    await ok(`${GATEWAY}/session-service/public/v2/session/web/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(session),
    });
}

export const tango: Provider = {
    name: "tango",
    matches: ["https://tango.me/*", "https://www.tango.me/*"],

    matchRoute(pathname: string): Route {
        const match = pathname.match(/^\/stream\/([^/]+)/);
        return match
            ? { handler: Handler.Stream, streamId: decodeURIComponent(match[1]) }
            : { handler: Handler.Home };
    },

    streamUrl(streamId: string): string {
        return `/stream/${encodeURIComponent(streamId)}`;
    },

    async startAuthentication(): Promise<() => void> {
        await refreshSession();
        await this.refreshStreamTokens();
        const short = window.setInterval(() => void this.refreshStreamTokens(), 5_000);
        const session = window.setInterval(() => void refreshSession(), 30 * 60_000);
        const resume = () => void this.refreshStreamTokens();
        addEventListener("pageshow", resume);
        return () => {
            clearInterval(short);
            clearInterval(session);
            removeEventListener("pageshow", resume);
        };
    },

    async refreshStreamTokens(): Promise<void> {
        await ok(`${PUBLIC}/live/stream/v1/tokenData`);
    },

    async fetchStreams(): Promise<Stream[]> {
        const [blockedResponse, followed, recommended] = await Promise.all([
            ok(`${GATEWAY}/abregistrar/connection/v1/blocklist`),
            recommendator("/recommendator/social/v2/list/following?includeAlias=true", true),
            recommendator("/recommendator/social/v2/list/following_recommendations", false),
        ]);
        const blockedBody = JSON.parse(blockedResponse.text) as string[] | { users?: string[] };
        const blocked = new Set(Array.isArray(blockedBody) ? blockedBody : blockedBody.users ?? []);
        return dedupe([...followed, ...recommended]).filter(stream => !blocked.has(stream.streamerId));
    },

    async fetchCostreamers(stream: Stream): Promise<Stream[]> {
        const response = await ok(`${PUBLIC}/live/stream/v2/watch?requestId=${crypto.randomUUID()}`, {
            method: "POST",
            body: stream.streamId,
        });
        const body = JSON.parse(response.text);
        const items: any[] = body.multiBroadcast?.streams ?? [];
        const streams: Stream[] = [];
        for (const item of items) {
            const descriptor = item.stream?.mbDescriptor;
            if (!descriptor?.accountId || !descriptor.streamId || !item.stream?.streamURL) continue;
            if (descriptor.accountId === stream.streamerId) continue;
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
        try {
            const response = await ok(`${GATEWAY}/proxycador/api/profiles/v2/single?id=${encodeURIComponent(stream.streamerId)}&basicProfile=true&liveStats=false&followStats=false`);
            const profile = JSON.parse(response.text).basicProfile;
            return {
                ...stream,
                alias: profile?.aliases?.[0]?.alias ?? stream.alias,
                firstName: profile?.firstName ?? stream.firstName,
            };
        } catch {
            return stream;
        }
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
        const body = await response.json() as unknown;
        return new Set(Array.isArray(body) ? body.filter((id): id is string => typeof id === "string") : []);
    },

    async addToDownloadList(streamerId: string): Promise<void> {
        await fetch(`${DOWNLOADS}/add`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ identifier: streamerId }),
        });
    },

    async removeFromDownloadList(streamerId: string): Promise<void> {
        await fetch(`${DOWNLOADS}/remove`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ identifier: streamerId }),
        });
    },
};
