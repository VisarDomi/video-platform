import { VIDEO_TYPE } from '../constants.js';
import type { Video } from '../types.js';
import {
    AuthenticationRequiredError,
    type MediaSource,
    type OnlineVideoProvider,
    type VideoPage,
} from './types.js';

// What XVideos and Porntrex share in Video Vault: the signed-in account's uploads, read from
// fetched pages of the site itself (whose scripts never run), labelled by their recording,
// played from their video page, and naming their recording's streamer for the +/- button.
// Each site supplies only its list paging, sign-in check and media sources.

export interface UploadSite {
    readonly id: 'xvideos' | 'porntrex';
    readonly name: string;
    // Its own HTTPS origin, for pages read from another site (Video Vault reads XVideos on porntrex.com).
    readonly origin: string;
    readonly hosts: readonly string[];
    readonly homeUrl: string;
    readonly loginUrl: string;
    readonly routes: { readonly list: RegExp; readonly login: RegExp; readonly video: RegExp };
}

export interface UploadSiteParts {
    fetchPage(cursor?: string, signal?: AbortSignal): Promise<VideoPage>;
    // Resolves once the account is signed in; throws while it is not.
    signedIn(): Promise<void>;
    source(document: Document, signal?: AbortSignal): Promise<MediaSource>;
}

// Sizes are estimates at 4 Mbps.
const BYTES_PER_SECOND = 4_000_000 / 8;
const SIGN_IN_POLL_MS = 3_000;

export function uploadSite(site: UploadSite) {
    // On the site: this tab's origin and cookies, even when the site links its other host (www or
    // not). Elsewhere (Video Vault): the site's own origin, read through the app.
    const here = () => site.hosts.includes(location.hostname);
    const origin = () => here() ? location.origin : site.origin;
    function url(raw: string, base = here() ? location.href : `${site.origin}/`): URL {
        const target = new URL(raw, base);
        if (target.protocol !== 'https:' || !site.hosts.includes(target.hostname)) {
            throw new Error(`Unexpected ${site.name} page URL.`);
        }
        return new URL(target.pathname + target.search, origin());
    }

    // A link's path on this site; links elsewhere (ads, other sites) have none.
    function path(raw: string, base?: string): string | undefined {
        try { return url(raw, base).pathname; } catch { return undefined; }
    }

    // A fetched page, and the path it landed on after redirects.
    async function read(page: string, signal?: AbortSignal): Promise<{ document: Document; landed: string }> {
        const target = url(page);
        const response = here() ? await fetch(target, { credentials: 'same-origin', cache: 'no-store', signal }) : await bridged(target, signal);
        if (response.status === 401 || response.status === 403) throw new AuthenticationRequiredError(`${site.name} login is required.`);
        if (response.status < 200 || response.status > 299) throw new Error(`${site.name} page unavailable (${response.status}).`);
        const landed = new URL(response.url);
        if (landed.origin !== origin()) throw new Error(`${site.name} left this site; open ${site.homeUrl} again.`);
        return { document: new DOMParser().parseFromString(await response.text(), 'text/html'), landed: landed.pathname };
    }

    // Video Vault's app reads the site's page with the site's own cookies (VideoApp/SiteWorker.swift);
    // the vault page itself cannot (the site allows no other origins).
    async function bridged(target: URL, signal?: AbortSignal): Promise<{ status: number; url: string; text(): Promise<string> }> {
        const bridge = window.webkit?.messageHandlers?.vaultSite;
        if (!bridge) throw new Error(`${site.name} can only be read in its own app.`);
        const reply = await bridge.postMessage({ site: site.id, path: target.pathname + target.search }) as { status: number; url: string; text: string };
        signal?.throwIfAborted();
        return { status: reply.status, url: reply.url, text: async () => reply.text };
    }

    // An uploads-list row; null unless it links one of this site's video pages and is one of the
    // pipeline's uploads (see isPipelineUpload). Identity is per upload, so one owner's uploads
    // stay distinct.
    function upload(id: string, href: string, title: string | null | undefined, seconds: number): Video | null {
        const pageUrl = path(href);
        if (!pageUrl || !site.routes.video.test(pageUrl) || !isPipelineUpload(title ?? '')) return null;
        return {
            filename: id, provider: site.id, type: VIDEO_TYPE.ORIGINAL, duration: seconds, size: 0, isLive: false,
            pageUrl, title: uploadLabel(title?.trim() || `Video ${id}`),
        };
    }

    function provider(parts: UploadSiteParts): OnlineVideoProvider {
        return {
            id: site.id, kind: 'online', homeUrl: site.homeUrl, loginUrl: site.loginUrl, estimatedBytesPerSecond: BYTES_PER_SECOND,
            matchRoute(page) {
                if (site.routes.list.test(page)) return 'list';
                if (site.routes.login.test(page)) return 'login';
                return site.routes.video.test(page) ? 'video' : null;
            },
            videoUrl: video => url(video.pageUrl!).pathname,
            fetchPage: parts.fetchPage,
            async resolvePlayback(video, signal) {
                const { document } = await read(video.pageUrl ?? location.pathname, signal);
                return parts.source(document, signal);
            },
            // The recording folder's streamer in the label, as the local apps' +/- button lists
            // recordings. Never from the video page's title: XVideos turns `_` into spaces there.
            uploadStreamer: video => video.title?.match(/^\d{4}-\d{2}-\d{2}\s+\d{6}\s+(.+?)(?:\s+\|.*)?$/)?.[1],
            // The site's own login page stays usable; once signed in, open the uploads (or the
            // page that sent the viewer here, such as Video Vault).
            async waitForLogin(home = site.homeUrl) {
                for (;;) {
                    try {
                        await parts.signedIn();
                        location.replace(home);
                        return;
                    } catch { /* Still signed out. */ }
                    await new Promise<void>(resolve => window.setTimeout(resolve, SIGN_IN_POLL_MS));
                }
            },
        };
    }

    return { url, path, read, upload, provider };
}

// The recording's `YYYY-MM-DD HHMMSS` timestamp names an upload: bracketed text containing it
// is the display label, without brackets; otherwise the title from the timestamp on. Titles
// without one keep their full text.
const RECORDED = /\b(\d{4}-\d{2}-\d{2})\s+(\d{6})\b/;
const BRACKETED_RECORDING = /\[([^\]]*\b\d{4}-\d{2}-\d{2}\s+\d{6}\b[^\]]*)\]/;

// Video Vault lists only the pipeline's uploads: their title carries the recording in brackets,
// "[YYYY-MM-DD HHMMSS streamer]" (one shape of a split adds " | part N"). Older manual uploads
// ("2023-06-14 155500 [68190398] asahi") and uploads taken out of the archive (renamed to the
// bare "YYYY-MM-DD HHMMSS streamer") are not listed.
export function isPipelineUpload(title: string): boolean {
    return BRACKETED_RECORDING.test(title);
}

export function uploadLabel(title: string): string {
    const bracketed = title.match(BRACKETED_RECORDING)?.[1].trim();
    if (bracketed) return bracketed;
    const at = title.search(RECORDED);
    return at < 0 ? title : title.slice(at).trim();
}

// A label's recording time, `YYYY-MM-DD HHMMSS`, which sorts as text.
export function uploadTime(label: string): string | undefined {
    const match = label.match(RECORDED);
    return match ? `${match[1]} ${match[2]}` : undefined;
}

// "1:02:03", "02:30", "16 min" or "1 h 2 min 3 sec" in seconds; 0 when absent.
export function duration(text: string): number {
    const clock = text.match(/\b\d+(?::\d{2}){1,2}\b/)?.[0];
    if (clock) return clock.split(':').reduce((total, part) => total * 60 + Number(part), 0);
    const units = text.match(/^\s*((?:\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b\s*)+)/i)?.[1] ?? '';
    return [...units.matchAll(/(\d+(?:\.\d+)?)\s*([hms])/gi)]
        .reduce((total, [, value, unit]) => total + Number(value) * ({ h: 3600, m: 60, s: 1 } as Record<string, number>)[unit.toLowerCase()], 0);
}

// Decode only JS string escapes; never execute scripts from fetched pages.
export function jsString(raw: string): string {
    return raw.replace(/\\(u[\da-f]{4}|x[\da-f]{2}|[\s\S])/gi, (_match, escape: string) => {
        if (escape[0] === 'u' || escape[0] === 'x') return String.fromCharCode(parseInt(escape.slice(1), 16));
        return ({ n: '\n', r: '\r', t: '\t' } as Record<string, string>)[escape] ?? escape;
    });
}

// A JS string literal in a fetched page's scripts, right after `before` (a pattern without
// capture groups), decoded.
export function scriptString(document: Document, before: string): string | undefined {
    const pattern = new RegExp(`${before}(['"])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`);
    for (const script of Array.from(document.scripts)) {
        const match = script.textContent?.match(pattern);
        if (match) return jsString(match[2]);
    }
    return undefined;
}

// A media source URL; only HTTPS.
export function sourceUrl(raw: string, base?: string): URL {
    const url = new URL(raw, base);
    if (url.protocol !== 'https:') throw new Error('Unexpected video source protocol.');
    return url;
}
