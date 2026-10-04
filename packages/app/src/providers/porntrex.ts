import type { Video } from '../types.js';
import { AuthenticationRequiredError, type MediaSource, type VideoPage } from './types.js';
import { duration, jsString, sourceUrl, uploadSite } from './uploadSite.js';

const UPLOADS = "/my/videos/";
const LIST = "#list_videos_my_uploaded_videos";
const LIST_PATH = /^\/my\/videos\/?$/;
const site = uploadSite({
    id: "porntrex", name: "Porntrex", origin: "https://www.porntrex.com", hosts: ["porntrex.com", "www.porntrex.com"], homeUrl: UPLOADS, loginUrl: "/login/",
    routes: { list: LIST_PATH, login: /^\/login\/?$/, video: /^\/video\/\d+\/[^/]+\/?$/ },
});

// Member pages redirect signed-out visitors to the home page.
async function uploadsPage(path: string, signal?: AbortSignal): Promise<Document> {
    const { document, landed } = await site.read(path, signal);
    if (document.querySelector(LIST)) return document;
    if (!LIST_PATH.test(landed) || document.querySelector('input[type="password"]')) {
        throw new AuthenticationRequiredError("Log in to Porntrex, then return to your videos.");
    }
    throw new Error("Could not read your Porntrex videos. Open /my/videos/ to check your session.");
}

function parseUploads(document: Document): Video[] {
    return Array.from(document.querySelectorAll(`${LIST} [data-item-id]`)).flatMap(row => {
        const id = row.getAttribute("data-item-id");
        const link = id && /^\d+$/.test(id) ? row.querySelector(`p.inf a[href*="/video/${id}/"]`) : null;
        const video = link && site.upload(id!, link.getAttribute("href")!, link.textContent, duration(row.querySelector(".durations")?.textContent ?? ""));
        return video ? [video] : [];
    });
}

// "My Videos" shows 30 uploads per page. Its pagination links are AJAX calls
// (data-parameters "from_my_videos:N"); page N is the list's own async block.
function uploadsPagePath(page: number): string {
    return page === 1 ? UPLOADS
        : `${UPLOADS}?mode=async&function=get_block&block_id=list_videos_my_uploaded_videos&sort_by=&from_my_videos=${page}`;
}

// Follow the site's pagination: a next page exists only if this page links it.
function nextUploadsPage(document: Document, page: number): number | undefined {
    const linked = Array.from(document.querySelectorAll("a[data-parameters*='from_my_videos:']"),
        link => Number(link.getAttribute("data-parameters")?.match(/from_my_videos:0*(\d+)/)?.[1] ?? NaN));
    return linked.includes(page + 1) ? page + 1 : undefined;
}

async function fetchPage(cursor?: string, signal?: AbortSignal): Promise<VideoPage> {
    const page = cursor === undefined ? 1 : Number(cursor);
    if (!Number.isSafeInteger(page) || page < (cursor === undefined ? 1 : 2)) throw new Error("Invalid uploads page cursor.");
    const document = await uploadsPage(uploadsPagePath(page), signal);
    const next = nextUploadsPage(document, page);
    return { videos: parseUploads(document), nextPage: next === undefined ? undefined : String(next) };
}

// The player's flashvars list one MP4 per quality: video_url, video_alt_url, video_alt_url2…
// each with a `<key>_text` label such as "1080p FHD". Highest resolution first.
function playerSources(document: Document): { url: string; quality: string }[] {
    const field = /\b(video_(?:alt_)?url\d*(?:_text)?)\s*:\s*(['"])((?:\\.|(?!\2)[^\\])*)\2/g;
    for (const script of Array.from(document.scripts)) {
        const fields = new Map(Array.from(script.textContent?.matchAll(field) ?? [], match => [match[1], jsString(match[3])]));
        if (!fields.has("video_url")) continue;
        const sources: { url: string; quality: string; height: number }[] = [];
        for (const [key, raw] of fields) {
            if (key.endsWith("_text") || !raw) continue;
            if (raw.startsWith("function/")) throw new Error("Porntrex returned an encoded video source.");
            const quality = fields.get(key + "_text") ?? "";
            sources.push({ url: sourceUrl(raw, location.href).href, quality: quality || "Only available source", height: Number(quality.match(/(\d{3,4})p/)?.[1] ?? 0) });
        }
        return sources.sort((a, b) => b.height - a.height).map(({ url, quality }) => ({ url, quality }));
    }
    return [];
}

async function source(document: Document): Promise<MediaSource> {
    const best = playerSources(document)[0];
    if (!best) throw new Error("This video is unavailable or is still processing. Check its status in your Porntrex account.");
    return { ...best, kind: "mp4" };
}

export const porntrex = site.provider({
    fetchPage, source,
    signedIn: async () => { await uploadsPage(UPLOADS); },
});
