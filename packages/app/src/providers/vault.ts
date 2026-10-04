import { VIDEO_TYPE } from '../constants.js';
import type { Video } from '../types.js';
import { porntrex } from './porntrex.js';
import { AuthenticationRequiredError, type Notice, type OnlineVideoProvider, type VideoPage } from './types.js';
import { uploadTime } from './uploadSite.js';
import { xvideos } from './xvideos.js';

// Video Vault, the iPhone app that replaced Ptrex: both upload sites' uploads in one list,
// oldest recording first. It lives on porntrex.com, whose pages and media it reads itself.
// XVideos pages come through the app's hidden xvideos.com page (VideoApp/SiteWorker.swift)
// and XVideos media plays from its CDN. It cannot live on xvideos.com instead: XVideos'
// security policy blocks Porntrex media.
export const PORNTREX_HOSTS = ['porntrex.com', 'www.porntrex.com'];
export const XVIDEOS_HOSTS = ['xvideos.com', 'www.xvideos.com'];
export const VAULT_HOME = '/video-vault/';
export const VAULT_URL = `https://www.porntrex.com${VAULT_HOME}`;
const XVIDEOS_LOGIN = 'https://www.xvideos.com/account';
const WATCH = /^\/video-vault\/(xvideos|porntrex)(\/.+)$/;

const SITES = { xvideos, porntrex };
type Site = keyof typeof SITES;
const SITE_NAMES: Record<Site, string> = { xvideos: 'Xvid', porntrex: 'Ptrex' };
const isSite = (value: string): value is Site => value in SITES;

// Each site's cursor (absent: first page, null: finished) and what went wrong so far.
interface Cursor {
    sites: Partial<Record<Site, string | null>>;
    notices: Notice[];
    incomplete: Site[];
}

function watchUrl(video: Video): string {
    return `${VAULT_HOME}${video.provider}${video.pageUrl}`;
}

// A signed-out site keeps its earlier rows and says how to sign it back in. Porntrex must not
// be logged into on the phone: its newest login signs every other device (the pipeline) out.
function signedOut(site: Site): Notice {
    return site === 'xvideos'
        ? { text: 'XVideos is signed out. Tap to log in; its uploads below are from the last complete list.', href: XVIDEOS_LOGIN }
        : { text: 'Porntrex is signed out: run `npm run ptrex:connect-iphone` on the PC (do not log in here; it would sign the pipeline out). Its uploads below are from the last complete list.' };
}

// Both sites' next pages at once. A site that fails for another reason is retried with the
// other site's next page, and on its own (with the catalog's back-off) once that one is done.
async function fetchPage(raw?: string, signal?: AbortSignal): Promise<VideoPage> {
    const cursor: Cursor = raw ? JSON.parse(raw) : { sites: {}, notices: [], incomplete: [] };
    const pending = (Object.keys(SITES) as Site[]).filter(site => cursor.sites[site] !== null);
    let progressed = false, failure: unknown;
    // In site order, whichever answers first: equal timestamps keep a stable order.
    const listed = await Promise.all(pending.map(async site => {
        try {
            const page = await SITES[site].fetchPage(cursor.sites[site] ?? undefined, signal);
            cursor.sites[site] = page.nextPage ?? null;
            progressed = true;
            return page.videos.map(video => ({ ...video, filename: `${site}-${video.filename}` }));
        } catch (error) {
            if (!(error instanceof AuthenticationRequiredError) || signal?.aborted) { failure ??= error; return []; }
            cursor.sites[site] = null;
            cursor.notices.push(signedOut(site));
            cursor.incomplete.push(site);
            progressed = true;
            return [];
        }
    }));
    const videos = listed.flat();
    if (failure !== undefined && !progressed) throw failure;
    if (failure !== undefined) console.error('Video Vault: a site\'s page failed; retrying', failure);
    const done = (Object.keys(SITES) as Site[]).every(site => cursor.sites[site] === null);
    return { videos, nextPage: done ? undefined : JSON.stringify(cursor), notices: cursor.notices, incomplete: cursor.incomplete };
}

// The recording a label names: its timestamp and the streamer after it.
function recording(video: Video): string | undefined {
    const match = video.title?.match(/\b(\d{4}-\d{2}-\d{2})\s+(\d{6})\b(?:\s+([^\s|]+))?/);
    return match ? [match[1], match[2], match[3]].filter(Boolean).join(' ') : undefined;
}

export const vault: OnlineVideoProvider = {
    id: 'vault', kind: 'online', homeUrl: VAULT_HOME, loginUrl: VAULT_HOME, estimatedBytesPerSecond: 4_000_000 / 8,
    matchRoute(path) {
        if (path === VAULT_HOME) return 'list';
        const match = path.match(WATCH);
        return match && isSite(match[1]) && SITES[match[1]].matchRoute(match[2]) === 'video' ? 'video' : null;
    },
    videoUrl: watchUrl,
    fetchPage,
    resolvePlayback: (video, signal) => vaultSites[video.provider as Site].resolvePlayback(video, signal),
    async waitForLogin() {},
    // Oldest recording first, by the timestamp in each label; uploads without one go last, in site order.
    order(videos) {
        return videos.map((video, index) => ({ video, index, time: uploadTime(video.title ?? '') }))
            .sort((a, b) => a.time && b.time ? a.time.localeCompare(b.time) || a.index - b.index : a.time ? -1 : b.time ? 1 : a.index - b.index)
            .map(({ video }) => video);
    },
    // The same recording on both sites shows which site each row is.
    marks(videos) {
        const sites = new Map<string, Set<string>>();
        for (const video of videos) {
            const key = recording(video);
            if (key) sites.set(key, (sites.get(key) ?? new Set()).add(video.provider));
        }
        return new Map(videos.flatMap(video => {
            const key = recording(video);
            return key && sites.get(key)!.size > 1 && isSite(video.provider) ? [[video.filename, SITE_NAMES[video.provider]]] : [];
        }));
    },
    // A viewer opened from its URL alone (a restored app): the site's own page identifies it.
    routeVideo(path) {
        const match = path.match(WATCH);
        if (!match || !isSite(match[1]) || SITES[match[1]].matchRoute(match[2]) !== 'video') return undefined;
        return { filename: path, provider: match[1], pageUrl: match[2], type: VIDEO_TYPE.ORIGINAL, duration: 0, size: 0, isLive: false };
    },
};

// The sites as the vault's player and download-list button use them: their videos live
// under the vault's routes; XVideos logs in on its own page, Porntrex never on the phone.
export const vaultSites: Record<Site, OnlineVideoProvider> = {
    xvideos: { ...xvideos, videoUrl: watchUrl, loginUrl: XVIDEOS_LOGIN, waitForLogin: () => xvideos.waitForLogin(VAULT_URL) },
    porntrex: { ...porntrex, videoUrl: watchUrl, loginUrl: VAULT_HOME },
};

// Ptrex's own pages (a restored Ptrex tab, or anything else on porntrex.com) open in the vault.
export function vaultRoute(path: string): string {
    if (vault.matchRoute(path)) return path;
    return porntrex.matchRoute(path) === 'video' ? `${VAULT_HOME}porntrex${path}` : VAULT_HOME;
}
