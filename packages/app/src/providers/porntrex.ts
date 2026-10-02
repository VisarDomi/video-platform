import { VIDEO_TYPE } from '../constants.js';
import type { Video } from '../types.js';
import { AuthenticationRequiredError, type OnlineVideoProvider, type MediaSource } from './types.js';
import { uploadLabel } from './uploadTitle.js';

const UPLOADS = "/my/videos/";
const LIST = "#list_videos_my_uploaded_videos";
const VIDEO_PATH = /^\/video\/\d+\/[^/]+\/?$/;
const LIST_PATH = /^\/my\/videos\/?$/;

function siteUrl(raw: string, base = location.href): URL {
    const url = new URL(raw, base);
    if (url.protocol !== "https:" || !["porntrex.com", "www.porntrex.com"].includes(url.hostname)) {
        throw new Error("Unexpected Porntrex page URL.");
    }
    // Use this tab's cookies and origin even when the site emits www links.
    return new URL(url.pathname + url.search, location.origin);
}

async function pageDocument(path: string, signal?: AbortSignal): Promise<Document> {
    const response = await fetch(siteUrl(path), { credentials: "same-origin", cache: "no-store", signal });
    if (!response.ok) throw new Error(`Porntrex page unavailable (${response.status}).`);
    if (new URL(response.url).origin !== location.origin) throw new Error("Porntrex left this site; open /my/videos/ again.");
    // Member pages redirect signed-out visitors to the home page.
    if (LIST_PATH.test(path) && !LIST_PATH.test(new URL(response.url).pathname)) {
        throw new AuthenticationRequiredError("Log in to Porntrex, then return to your videos.");
    }
    return new DOMParser().parseFromString(await response.text(), "text/html");
}

export function clockDuration(text: string): number {
    const value = text.match(/\b\d+(?::\d{2}){1,2}\b/)?.[0];
    return value ? value.split(":").reduce((total, part) => total * 60 + Number(part), 0) : 0;
}

function requireUploadsPage(document: Document): Element {
    const list = document.querySelector(LIST);
    if (list) return list;
    if (document.querySelector('input[type="password"]')) {
        throw new AuthenticationRequiredError("Log in to Porntrex, then return to your videos.");
    }
    throw new Error("Could not read your Porntrex videos. Open /my/videos/ to check your session.");
}

export function parseUploads(document: Document): Video[] {
    const videos: Video[] = [];
    for (const row of Array.from(requireUploadsPage(document).querySelectorAll("[data-item-id]"))) {
        const id = row.getAttribute("data-item-id");
        const link = id && /^\d+$/.test(id) ? row.querySelector<HTMLAnchorElement>(`p.inf a[href*="/video/${id}/"]`) : null;
        if (!id || !link) continue;
        const url = siteUrl(link.getAttribute("href")!);
        if (!VIDEO_PATH.test(url.pathname)) continue;
        const title = link.textContent?.trim() || `Video ${id}`;
        videos.push({
            filename: id,
            provider: "porntrex", type: VIDEO_TYPE.ORIGINAL, duration: clockDuration(row.querySelector(".durations")?.textContent ?? ""),
            size: 0, isLive: false,
            pageUrl: url.pathname,
            title: uploadLabel(title),
        });
    }
    return videos;
}

async function fetchPage(cursor?: string, signal?: AbortSignal): Promise<{ videos: Video[]; nextPage?: string }> {
    if (cursor !== undefined) throw new Error("Invalid uploads page cursor.");
    const document = await pageDocument(UPLOADS, signal);
    const videos = parseUploads(document);
    // Pagination is added once an account has enough uploads to show its format.
    const total = Number(document.querySelector(`${LIST} h2`)?.textContent?.match(/\((\d+)\)/)?.[1] ?? NaN);
    if (total > videos.length) console.warn(`Porntrex lists ${total} videos; only the first ${videos.length} are shown.`);
    return { videos };
}

// Decode only JS string escapes; never execute scripts from fetched pages.
function stringValue(raw: string): string {
    return raw.replace(/\\(u[\da-f]{4}|x[\da-f]{2}|[\s\S])/gi, (_match, escape: string) => {
        if (escape[0] === "u" || escape[0] === "x") return String.fromCharCode(parseInt(escape.slice(1), 16));
        return ({ n: "\n", r: "\r", t: "\t" } as Record<string, string>)[escape] ?? escape;
    });
}

// The player's flashvars list one MP4 per quality: video_url, video_alt_url, video_alt_url2…
// each with a `<key>_text` label such as "1080p FHD". Highest resolution first.
export function playerSources(document: Document): { url: string; quality: string }[] {
    const field = /\b(video_(?:alt_)?url\d*(?:_text)?)\s*:\s*(['"])((?:\\.|(?!\2)[^\\])*)\2/g;
    for (const script of Array.from(document.scripts)) {
        const fields = new Map(Array.from(script.textContent?.matchAll(field) ?? [], match => [match[1], stringValue(match[3])]));
        if (!fields.has("video_url")) continue;
        const sources: { url: string; quality: string; height: number }[] = [];
        for (const [key, raw] of fields) {
            if (key.endsWith("_text") || !raw) continue;
            if (raw.startsWith("function/")) throw new Error("Porntrex returned an encoded video source.");
            const url = new URL(raw, location.href);
            if (url.protocol !== "https:") throw new Error("Unexpected video source protocol.");
            const quality = fields.get(key + "_text") ?? "";
            sources.push({ url: url.href, quality: quality || "Only available source", height: Number(quality.match(/(\d{3,4})p/)?.[1] ?? 0) });
        }
        return sources.sort((a, b) => b.height - a.height).map(({ url, quality }) => ({ url, quality }));
    }
    return [];
}

async function resolvePlayback(video: Video, signal?: AbortSignal): Promise<MediaSource> {
    const source = playerSources(await pageDocument(video.pageUrl ?? location.pathname, signal))[0];
    if (!source) throw new Error("This video is unavailable or is still processing. Check its status in your Porntrex account.");
    return { ...source, kind: "mp4" };
}

export const porntrex: OnlineVideoProvider = {
    id: "porntrex", kind: "online", homeUrl: UPLOADS, loginUrl: "/login/", estimatedBytesPerSecond: 4_000_000 / 8,
    matchRoute(path) {
        if (LIST_PATH.test(path)) return "list";
        if (/^\/login\/?$/.test(path)) return "login";
        return VIDEO_PATH.test(path) ? "video" : null;
    },
    videoUrl: video => siteUrl(video.pageUrl!).pathname,
    fetchPage, resolvePlayback,
    async waitForLogin() {
        for (;;) {
            try {
                requireUploadsPage(await pageDocument(UPLOADS));
                location.replace(UPLOADS);
                return;
            } catch { /* Still signed out; keep the native login form. */ }
            await new Promise<void>(resolve => window.setTimeout(resolve, 3_000));
        }
    },
};
