import { AuthenticationRequiredError, Handler, type Provider, type Route, type Stream } from "../types";

const UPLOADS = "/account/uploads";
const VIDEO_PATH = /^\/video(?:\.[a-z0-9]+|[0-9]+|-[a-z0-9]+)\/[^/]+\/?$/i;
const LIST_PATH = /^\/account\/uploads(?:\/\d+)?\/?$/;
let authenticatedUploads: Document | undefined;

function siteUrl(raw: string, base = location.href): URL {
    const url = new URL(raw, base);
    if (url.protocol !== "https:" || !["xvideos.com", "www.xvideos.com"].includes(url.hostname)) {
        throw new Error("Unexpected XVideos page URL.");
    }
    // Use this tab's cookies and origin even when the site emits www links.
    return new URL(url.pathname + url.search, location.origin);
}

async function pageDocument(path: string, signal?: AbortSignal): Promise<Document> {
    const response = await fetch(siteUrl(path), { credentials: "same-origin", cache: "no-store", signal });
    if (response.status === 401 || response.status === 403) throw new AuthenticationRequiredError("XVideos login is required.");
    if (!response.ok) throw new Error(`XVideos page unavailable (${response.status}).`);
    if (new URL(response.url).origin !== location.origin) throw new Error("Log in to XVideos at /account, then return to your uploads.");
    const document = new DOMParser().parseFromString(await response.text(), "text/html");
    if (LIST_PATH.test(path)) {
        requireUploadsPage(document);
        const canonical = (pathname: string) => pathname.replace(/\/$/, "").replace(/\/0$/, "");
        if (canonical(new URL(response.url).pathname) !== canonical(path)) {
            throw new Error("XVideos redirected this uploads page.");
        }
    }
    return document;
}

export function parseUploads(document: Document): Stream[] {
    const streams: Stream[] = [];
    for (const row of Array.from(document.querySelectorAll('[id^="listing-video-"]'))) {
        const id = row.id.match(/^listing-video-(\d+)$/)?.[1];
        const link = Array.from(row.querySelectorAll<HTMLAnchorElement>(".title a[href]"))
            .find(a => VIDEO_PATH.test(siteUrl(a.getAttribute("href")!).pathname));
        if (!id || !link) continue;
        const url = siteUrl(link.getAttribute("href")!);
        streams.push({
            // Identity is per video, so different uploads from one owner remain distinct.
            streamerId: id,
            streamId: url.pathname,
            firstName: link.textContent?.trim() || `Video ${id}`,
            masterListUrl: "", // Resolve signed media URLs only when a slot needs them.
            isFollowing: false,
        });
    }
    return streams;
}

function requireUploadsPage(document: Document): void {
    if (document.querySelector('[id^="listing-video-"]')) return;
    if (document.querySelector('a.social-login-icon[data-method="signin"], input[type="password"]')) {
        throw new AuthenticationRequiredError("Log in to XVideos at /account, then return to your uploads.");
    }
    if (!document.querySelector('a[href="/account/uploads/new"]')) {
        throw new Error("Could not read your XVideos uploads. Open /account to check your session.");
    }
}

async function fetchStreamPage(cursor?: string, signal?: AbortSignal): Promise<{ streams: Stream[]; nextPage?: string }> {
    const { pending, visited } = cursor ? JSON.parse(cursor) as { pending: string[]; visited: string[] }
        : { pending: [UPLOADS], visited: [] as string[] };
    if (!Array.isArray(pending) || !pending.length || !Array.isArray(visited)
        || [...pending, ...visited].some(path => typeof path !== "string" || !LIST_PATH.test(path))) {
        throw new Error("Invalid uploads page cursor.");
    }
    const path = pending.shift()!;
    const document = path === UPLOADS && authenticatedUploads
        ? authenticatedUploads : await pageDocument(path, signal);
    if (path === UPLOADS) authenticatedUploads = undefined;
    requireUploadsPage(document);
    visited.push(path);
    const queued = new Set([...visited, ...pending]);
    const pages = Array.from(document.querySelectorAll<HTMLAnchorElement>('.pagination a[href]'))
        .map(link => siteUrl(link.getAttribute("href")!, new URL(path, location.origin).href).pathname)
        .filter(path => LIST_PATH.test(path))
        .sort((a, b) => Number(a.split("/")[3] || 0) - Number(b.split("/")[3] || 0));
    for (const page of pages) {
        const canonical = page.replace(/\/$/, "").replace(/\/0$/, "");
        if (!queued.has(canonical)) { queued.add(canonical); pending.push(canonical); }
    }
    return { streams: parseUploads(document), nextPage: pending.length ? JSON.stringify({ pending, visited }) : undefined };
}

async function fetchStreams(): Promise<Stream[]> {
    const result = new Map<string, Stream>();
    let cursor: string | undefined;
    do {
        const page = await fetchStreamPage(cursor);
        for (const stream of page.streams) if (!result.has(stream.streamerId)) result.set(stream.streamerId, stream);
        cursor = page.nextPage;
    } while (cursor);
    return [...result.values()];
}

// Decode only JS string escapes; never execute scripts from fetched pages.
function stringValue(raw: string): string {
    return raw.replace(/\\(u[\da-f]{4}|x[\da-f]{2}|[\s\S])/gi, (_match, escape: string) => {
        if (escape[0] === "u" || escape[0] === "x") return String.fromCharCode(parseInt(escape.slice(1), 16));
        return ({ n: "\n", r: "\r", t: "\t" } as Record<string, string>)[escape] ?? escape;
    });
}

export function mediaSource(document: Document, setter: string): string | undefined {
    const pattern = new RegExp(`\\bhtml5player\\.${setter}\\(\\s*(['"])((?:\\\\.|(?!\\1)[^\\\\])*)\\1\\s*\\)`);
    for (const script of Array.from(document.scripts)) {
        const match = script.textContent?.match(pattern);
        if (match) return mediaUrl(stringValue(match[2])).href;
    }
    return undefined;
}

function mediaUrl(raw: string, base?: string): URL {
    const url = new URL(raw, base);
    if (url.protocol !== "https:") throw new Error("Unexpected video source protocol.");
    return url;
}

export function fullQualityMaster(source: string): string {
    const url = mediaUrl(source);
    // XVideos gives Safari hls_low.m3u8, whose variants omit HD. The sibling
    // full master uses the same signed directory and exposes all resolutions.
    url.pathname = url.pathname.replace(/\/hls_low\.m3u8$/, "/hls.m3u8");
    return url.href;
}

export function highestVariant(manifest: string, masterUrl: string): { url: string; quality: string } {
    if (!manifest.trimStart().startsWith("#EXTM3U")) throw new Error("Invalid XVideos quality playlist.");
    const lines = manifest.split(/\r?\n/).map(line => line.trim());
    const variants: { url: string; quality: string; pixels: number; bandwidth: number }[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
        const resolution = line.match(/\bRESOLUTION=(\d+)x(\d+)/);
        const width = Number(resolution?.[1] ?? 0);
        const height = Number(resolution?.[2] ?? 0);
        const bandwidth = Number(line.match(/(?:^|[:,])BANDWIDTH=(\d+)/)?.[1] ?? 0);
        const target = lines[i + 1];
        if (!target || target.startsWith("#")) throw new Error("Missing XVideos quality variant.");
        if (line.match(/\b(?:AUDIO|VIDEO)="/)) throw new Error("Unsupported external media tracks in XVideos playlist.");
        variants.push({ url: mediaUrl(target, masterUrl).href, quality: height ? `${Math.min(width, height)}p` : "Highest bitrate", pixels: width * height, bandwidth });
    }
    variants.sort((a, b) => b.pixels - a.pixels || b.bandwidth - a.bandwidth);
    if (!variants.length) throw new Error("XVideos did not expose selectable video qualities.");
    return { url: variants[0].url, quality: variants[0].quality };
}

async function resolvePlayback(stream: Stream): Promise<{ url: string; quality: string }> {
    const document = await pageDocument(stream.streamId);
    const hls = mediaSource(document, "setVideoHLS");
    if (hls) {
        const response = await fetch(fullQualityMaster(hls), { credentials: "omit", cache: "no-store" });
        if (!response.ok) throw new Error(`Could not load video qualities (${response.status}).`);
        return highestVariant(await response.text(), response.url);
    }
    const high = mediaSource(document, "setVideoUrlHigh");
    if (high) return { url: high, quality: "High" };
    const low = mediaSource(document, "setVideoUrlLow");
    if (low) return { url: low, quality: "Only available source" };
    throw new Error("This upload is unavailable or is still processing. Check its status in your XVideos account.");
}

export const xvideos: Provider = {
    playback: "video",
    homeUrl: UPLOADS,
    listTitle: "Uploads",
    nativeLogin: {
        path: "/account",
        async wait() {
            for (;;) {
                try {
                    requireUploadsPage(await pageDocument(UPLOADS));
                    return;
                } catch {
                    // Keep native login/challenge usable until authentication succeeds.
                }
                await new Promise<void>(resolve => window.setTimeout(resolve, 3_000));
            }
        },
    },
    matchRoute(pathname: string): Route | null {
        if (LIST_PATH.test(pathname) || /^\/account\/?$/.test(pathname)) return { handler: Handler.Home };
        if (VIDEO_PATH.test(pathname)) return { handler: Handler.Stream, streamId: pathname };
        return null;
    },
    streamUrl: streamId => siteUrl(streamId).pathname,
    async startAuthentication() {
        const document = await pageDocument(UPLOADS);
        requireUploadsPage(document);
        authenticatedUploads = document;
    },
    fetchStreams,
    fetchStreamPage,
    resolvePlayback,
    async enrichAll(streams) { return streams; },
    async enrich(stream) { return stream; },
};
