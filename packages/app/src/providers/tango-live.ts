import { VIDEO_TYPE } from '../constants.js';
import type { Video } from '../types.js';
import { AuthenticationRequiredError, type MediaSource, type OnlineVideoProvider } from './types.js';

// Live Tango streams on tango.me (formerly Stream Viewer's Tango provider). The page's own
// cookies authenticate; this document keeps the session and playback tokens fresh.
const GATEWAY = "https://gateway.tango.me";
const PUBLIC = `${GATEWAY}/proxycador/api/public/v1`;
const STREAM_PATH = /^\/stream\/([^/]+)\/?$/;
const MEDIA_KEY = "tango-live-media";

interface Result { status: number; text: string }

function request(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Result> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(init.method ?? "GET", url);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json; charset=UTF-8");
        for (const [name, value] of Object.entries(init.headers ?? {})) xhr.setRequestHeader(name, value);
        xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
        xhr.onerror = () => reject(new Error(`Request failed: ${url}`));
        xhr.send(init.body ?? null);
    });
}

async function ok(url: string, init?: Parameters<typeof request>[1]): Promise<Result> {
    const response = await request(url, init);
    if (response.status === 401 || response.status === 403) throw new AuthenticationRequiredError("Tango login is required.");
    if (response.status < 200 || response.status >= 300) throw new Error(`${url} returned ${response.status}`);
    return response;
}

function object(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is not an object`);
    return value as Record<string, unknown>;
}

function strings(value: unknown, label: string): string[] {
    if (!Array.isArray(value) || !value.every(item => typeof item === "string")) throw new Error(`${label} is not a string array`);
    return value;
}

// The account and session the refresh call names: the app supplies them for its web view;
// in Safari the Tango website stores them itself.
function sessionIDs(): { accountId: string; sessionId: string } {
    let accountId = localStorage.getItem("latest_account_id") ?? "";
    let sessionId = sessionStorage.getItem("username") ?? "";
    if (!accountId) {
        const stored = JSON.parse(localStorage.getItem("persist:production:user") ?? "{}") as { accountId?: string };
        accountId = stored.accountId ? JSON.parse(stored.accountId) as string : "";
    }
    if (!sessionId) {
        const stored = JSON.parse(localStorage.getItem("persist:production:sessionDetails") ?? "{}") as { data?: string };
        sessionId = (stored.data ? (JSON.parse(stored.data) as { sessionId?: string }).sessionId : "") ?? "";
    }
    if (!accountId || !sessionId) throw new AuthenticationRequiredError("Tango login is required.");
    return { accountId, sessionId };
}

async function refreshSession(): Promise<void> {
    await ok(`${GATEWAY}/session-service/public/v2/session/web/refresh`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sessionIDs()),
    });
}

async function refreshPlaybackTokens(): Promise<void> {
    await ok(`${PUBLIC}/live/stream/v1/tokenData`);
}

// Stream playlists are kept per tab so a reopened or restored stream page can play at once.
function media(): Record<string, string> {
    return JSON.parse(sessionStorage.getItem(MEDIA_KEY) ?? "{}") as Record<string, string>;
}
function remember(streams: { streamId: string; masterListUrl: string }[]): void {
    sessionStorage.setItem(MEDIA_KEY, JSON.stringify({ ...media(), ...Object.fromEntries(streams.map(s => [s.streamId, s.masterListUrl])) }));
}

interface Stream { streamerId: string; streamId: string; masterListUrl: string; firstName: string; alias?: string; following: boolean; parent?: string }

function toVideo(stream: Stream): Video {
    return {
        filename: stream.streamerId, provider: "tango-live", type: VIDEO_TYPE.ORIGINAL, duration: 0, size: 0, isLive: true,
        title: `${stream.alias || stream.streamerId} ${stream.firstName}`.trim(),
        pageUrl: `/stream/${encodeURIComponent(stream.streamId)}`,
        following: stream.following, parent: stream.parent,
    };
}

function recordToStream(record: any, following: boolean): Stream | null {
    const streamerId = record.anchor?.encryptedAccountId ?? record.stream?.encryptedAccountId;
    const streamId = record.stream?.id;
    const masterListUrl = record.stream?.masterListUrl;
    const isPublic = record.isPublic === true || record.stream?.streamKind === "PUBLIC";
    if (!streamerId || !streamId || !masterListUrl || record.stream?.status !== "LIVING" || !isPublic) return null;
    return { streamerId, streamId, masterListUrl, firstName: record.anchor?.firstName ?? streamerId, alias: record.anchor?.aliases?.[0]?.alias, following };
}

async function recommendations(path: string, following: boolean): Promise<Stream[]> {
    const response = await ok(`${GATEWAY}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const body = object(JSON.parse(response.text) as unknown, "Tango recommendation response");
    if (!Array.isArray(body.records)) throw new Error("Tango recommendation records are not an array");
    return body.records.map(record => recordToStream(record, following)).filter((stream): stream is Stream => stream !== null);
}

async function blocked(): Promise<Set<string>> {
    const body = JSON.parse((await ok(`${GATEWAY}/abregistrar/connection/v1/blocklist`)).text) as unknown;
    return new Set(Array.isArray(body) ? strings(body, "Tango blocklist") : strings(object(body, "Tango blocklist response").users, "Tango blocklist users"));
}

// Names are best effort: a failed lookup keeps the IDs.
async function named(streams: Stream[]): Promise<Stream[]> {
    if (!streams.length) return streams;
    try {
        const response = await ok(`${PUBLIC}/profiles/v2/batch?basicProfile=true&liveStats=false&followStats=false`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(streams.map(stream => stream.streamerId)),
        });
        const profiles = JSON.parse(response.text) as Record<string, { basicProfile?: { aliases?: { alias?: string }[]; firstName?: string } }>;
        return streams.map(stream => {
            const profile = profiles[stream.streamerId]?.basicProfile;
            return { ...stream, alias: profile?.aliases?.[0]?.alias ?? stream.alias, firstName: profile?.firstName ?? stream.firstName };
        });
    } catch (error) {
        console.warn("Tango profile names failed", error);
        return streams;
    }
}

// Followed streams first, then recommendations; one entry per streamer; never blocked ones.
async function fetchPage(): Promise<{ videos: Video[] }> {
    const [hidden, followed, recommended] = await Promise.all([
        blocked(),
        recommendations("/recommendator/social/v2/list/following?includeAlias=true", true),
        recommendations("/recommendator/social/v2/list/following_recommendations", false),
    ]);
    const unique = new Map<string, Stream>();
    for (const stream of [...followed, ...recommended]) {
        if (!hidden.has(stream.streamerId) && (!unique.has(stream.streamerId) || stream.following)) unique.set(stream.streamerId, stream);
    }
    const streams = await named([...unique.values()]);
    remember(streams);
    return { videos: streams.map(toVideo) };
}

async function resolvePlayback(video: Video): Promise<MediaSource> {
    const streamId = decodeURIComponent(video.pageUrl?.match(STREAM_PATH)?.[1] ?? "");
    let url = media()[streamId];
    if (!url) { await fetchPage(); url = media()[streamId]; }
    if (!url) throw new Error("This stream has ended.");
    return { url, kind: "hls" };
}

export const tangoLive: OnlineVideoProvider = {
    id: "tango-live", kind: "online", homeUrl: "/", estimatedBytesPerSecond: 0,
    // The app shows its native Safari-login handoff screen for this address.
    loginUrl: "videoapp://login",
    matchRoute(path) {
        if (path === "/") return "list";
        return STREAM_PATH.test(path) ? "video" : null;
    },
    videoUrl: video => video.pageUrl!,
    fetchPage, resolvePlayback,
    async waitForLogin() {},
    live: {
        downloadList: "tango",
        async start() {
            await refreshSession();
            await refreshPlaybackTokens();
            // These belong to this document, including its bfcache lifetime.
            window.setInterval(() => void refreshPlaybackTokens().catch(error => console.warn("Tango playback tokens", error)), 5_000);
            window.setInterval(() => void refreshSession().catch(error => console.warn("Tango session refresh", error)), 30 * 60_000);
            addEventListener("pageshow", () => void refreshPlaybackTokens().catch(() => undefined));
        },
        async follow(video, follow) {
            await ok(`${PUBLIC}/follow/${follow ? "add" : "remove"}`, { method: "POST", body: video.filename });
        },
        async block(video) {
            if (video.following) await ok(`${PUBLIC}/follow/remove`, { method: "POST", body: video.filename });
            const response = await ok(`${GATEWAY}/abregistrar/connection/v1/blocklist`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "BLOCK", account_id: [video.filename] }),
            });
            const result = JSON.parse(response.text) as { error_code?: number; error_message?: string };
            if (result.error_code !== 0) throw new Error(result.error_message || "Tango did not block this streamer.");
        },
        async related(video) {
            const streamId = decodeURIComponent(video.pageUrl?.match(STREAM_PATH)?.[1] ?? "");
            const [response, hidden] = await Promise.all([
                ok(`${PUBLIC}/live/stream/v2/watch?requestId=${crypto.randomUUID()}`, { method: "POST", body: streamId }),
                blocked(),
            ]);
            const multi = object(JSON.parse(response.text) as unknown, "Tango watch response").multiBroadcast;
            if (multi === undefined || multi === null) return [];
            const items = object(multi, "Tango multi-broadcast data").streams;
            if (!Array.isArray(items)) throw new Error("Tango multi-broadcast streams are not an array");
            const streams: Stream[] = [];
            for (const item of items as any[]) {
                const descriptor = item.stream?.mbDescriptor;
                if (!descriptor?.accountId || !descriptor.streamId || !item.stream?.streamURL) continue;
                if (descriptor.accountId === video.filename || hidden.has(descriptor.accountId)) continue;
                streams.push({ streamerId: descriptor.accountId, streamId: descriptor.streamId, masterListUrl: item.stream.streamURL,
                               firstName: descriptor.accountId, following: false, parent: video.filename });
            }
            const result = await named(streams);
            remember(result);
            return result.map(toVideo);
        },
    },
};
