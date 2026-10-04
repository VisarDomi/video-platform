import type { Video } from '../types.js';
import { AuthenticationRequiredError, type MediaSource, type VideoPage } from './types.js';
import { duration, scriptString, sourceUrl, uploadSite } from './uploadSite.js';

const UPLOADS = "/account/uploads";
const LIST_PATH = /^\/account\/uploads(?:\/\d+)?\/?$/;
const site = uploadSite({
    id: "xvideos", name: "XVideos", origin: "https://www.xvideos.com", hosts: ["xvideos.com", "www.xvideos.com"], homeUrl: UPLOADS, loginUrl: "/account",
    routes: { list: LIST_PATH, login: /^\/account\/?$/, video: /^\/video(?:\.[a-z0-9]+|[0-9]+|-[a-z0-9]+)\/[^/]+\/?$/i },
});

// The first uploads page is also page 0.
const canonical = (path: string) => path.replace(/\/$/, "").replace(/\/0$/, "");

async function uploadsPage(path: string, signal?: AbortSignal): Promise<Document> {
    const { document, landed } = await site.read(path, signal);
    if (!document.querySelector('[id^="listing-video-"]')) {
        if (document.querySelector('a.social-login-icon[data-method="signin"], input[type="password"]')) {
            throw new AuthenticationRequiredError("Log in to XVideos at /account, then return to your uploads.");
        }
        if (!document.querySelector('a[href="/account/uploads/new"]')) {
            throw new Error("Could not read your XVideos uploads. Open /account to check your session.");
        }
    }
    if (canonical(landed) !== canonical(path)) throw new Error("XVideos redirected this uploads page.");
    return document;
}

function parseUploads(document: Document): Video[] {
    return Array.from(document.querySelectorAll('[id^="listing-video-"]')).flatMap(row => {
        const id = row.id.match(/^listing-video-(\d+)$/)?.[1];
        const seconds = duration(row.querySelector(".title + p")?.textContent?.split(/\bDuration:/i)[1] ?? "");
        const video = id && Array.from(row.querySelectorAll(".title a[href]"),
            link => site.upload(id, link.getAttribute("href")!, link.textContent, seconds)).find(video => video !== null);
        return video ? [video] : [];
    });
}

// Pages are queued as the site links them, so later pages append in site order.
async function fetchPage(cursor?: string, signal?: AbortSignal): Promise<VideoPage> {
    const { pending, visited } = cursor ? JSON.parse(cursor) as { pending: string[]; visited: string[] }
        : { pending: [UPLOADS], visited: [] as string[] };
    if (!Array.isArray(pending) || !pending.length || !Array.isArray(visited)
        || [...pending, ...visited].some(path => typeof path !== "string" || !LIST_PATH.test(path))) {
        throw new Error("Invalid uploads page cursor.");
    }
    const path = pending.shift()!;
    const document = await uploadsPage(path, signal);
    visited.push(path);
    const queued = new Set([...visited, ...pending]);
    const pages = Array.from(document.querySelectorAll('.pagination a[href]'))
        .flatMap(link => site.path(link.getAttribute("href")!, site.url(path).href) ?? [])
        .filter(page => LIST_PATH.test(page))
        .sort((a, b) => Number(a.split("/")[3] || 0) - Number(b.split("/")[3] || 0));
    for (const page of pages.map(canonical)) {
        if (!queued.has(page)) { queued.add(page); pending.push(page); }
    }
    return { videos: parseUploads(document), nextPage: pending.length ? JSON.stringify({ pending, visited }) : undefined };
}

function playerSource(document: Document, setter: string): string | undefined {
    const raw = scriptString(document, `\\bhtml5player\\.${setter}\\(\\s*`);
    return raw === undefined ? undefined : sourceUrl(raw).href;
}

// XVideos gives Safari hls_low.m3u8, whose variants omit HD. The sibling
// full master uses the same signed directory and exposes all resolutions.
function fullQualityMaster(source: string): string {
    const url = sourceUrl(source);
    url.pathname = url.pathname.replace(/\/hls_low\.m3u8$/, "/hls.m3u8");
    return url.href;
}

function highestVariant(manifest: string, masterUrl: string): { url: string; quality: string } {
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
        variants.push({ url: sourceUrl(target, masterUrl).href, quality: height ? `${Math.min(width, height)}p` : "Highest bitrate", pixels: width * height, bandwidth });
    }
    variants.sort((a, b) => b.pixels - a.pixels || b.bandwidth - a.bandwidth);
    if (!variants.length) throw new Error("XVideos did not expose selectable video qualities.");
    return { url: variants[0].url, quality: variants[0].quality };
}

async function source(document: Document, signal?: AbortSignal): Promise<MediaSource> {
    const hls = playerSource(document, "setVideoHLS");
    if (hls) {
        const response = await fetch(fullQualityMaster(hls), { credentials: "omit", cache: "no-store", signal });
        if (!response.ok) throw new Error(`Could not load video qualities (${response.status}).`);
        return { ...highestVariant(await response.text(), response.url), kind: "hls" };
    }
    const high = playerSource(document, "setVideoUrlHigh");
    if (high) return { url: high, kind: "mp4", quality: "High" };
    const low = playerSource(document, "setVideoUrlLow");
    if (low) return { url: low, kind: "mp4", quality: "Only available source" };
    throw new Error("This upload is unavailable or is still processing. Check its status in your XVideos account.");
}

export const xvideos = site.provider({
    fetchPage, source,
    signedIn: async () => { await uploadsPage(UPLOADS); },
});
