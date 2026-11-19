import { resolveSegmentUrl } from "sdk";
import type { Latency } from "./config.js";

// The site's stream modes: mode = quality x 10 + latency. A higher quality is a higher
// rung of the ladder; the latency digit is 0 = low, 1 = high, 2 = middle. The handshake
// offers a media playlist per mode; the master lists the rungs (at low latency) with
// their resolution and bandwidth.

export const LATENCY_CODE: Record<Latency, number> = { low: 0, high: 1, middle: 2 };
const LATENCY_NAME = ["low", "high", "middle"] as const;

export const qualityOf = (mode: number) => Math.floor(mode / 10);
export const latencyOf = (mode: number) => mode % 10;
export const latencyName = (mode: number) => LATENCY_NAME[latencyOf(mode)] ?? "unknown";

// A media playlist URL names its mode: .../<mode>/playlist.m3u8
const MEDIA_PATH = /\/(\d+)\/playlist\.m3u8$/;

export function modeOfUrl(url: string): number | null {
    try {
        const match = MEDIA_PATH.exec(new URL(url).pathname);
        return match ? Number(match[1]) : null;
    } catch {
        return null;
    }
}

export interface Rung {
    quality: number;
    width: number;
    height: number;
    bandwidth: number;
    url: string;
}

export interface Offer {
    url: string;
    mode: number;
}

// The rungs a master playlist lists, best first.
export function parseLadder(master: string, masterUrl: string): Rung[] {
    const lines = master.split(/\r?\n/);
    const rungs: Rung[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
        const uri = lines[i + 1]?.trim();
        if (!uri || uri.startsWith("#")) continue;
        const url = resolveSegmentUrl(masterUrl, uri);
        const mode = modeOfUrl(url);
        if (mode === null) continue;
        const resolution = /RESOLUTION=(\d+)x(\d+)/.exec(line);
        rungs.push({
            quality: qualityOf(mode),
            width: resolution ? Number(resolution[1]) : 0,
            height: resolution ? Number(resolution[2]) : 0,
            bandwidth: Number(/BANDWIDTH=(\d+)/.exec(line)?.[1] ?? 0),
            url,
        });
    }
    return rungs.sort((a, b) => b.quality - a.quality || b.bandwidth - a.bandwidth);
}

export interface Selection {
    offer: Offer;
    rung: Rung | null;
}

// The playlist to capture: the highest rung within maxHeight, at the wanted latency
// when that rung offers it (else low, middle, high in that order). A rung whose height
// the master does not tell counts as unknown: it is taken only without a height cap.
export function selectPlaylist(offers: readonly Offer[], rungs: readonly Rung[], options: { latency: Latency; maxHeight: number | null }): Selection | null {
    const rungOf = new Map(rungs.map((rung) => [rung.quality, rung]));
    const allowed = offers.filter((offer) => {
        if (options.maxHeight === null) return true;
        const rung = rungOf.get(qualityOf(offer.mode));
        return rung !== undefined && rung.height > 0 && rung.height <= options.maxHeight;
    });
    if (allowed.length === 0) return null;
    const best = Math.max(...allowed.map((offer) => qualityOf(offer.mode)));
    const latencyOrder = [LATENCY_CODE[options.latency], LATENCY_CODE.low, LATENCY_CODE.middle, LATENCY_CODE.high];
    const rank = (offer: Offer) => {
        const index = latencyOrder.indexOf(latencyOf(offer.mode));
        return index === -1 ? latencyOrder.length : index;
    };
    const offer = allowed.filter((candidate) => qualityOf(candidate.mode) === best).sort((a, b) => rank(a) - rank(b))[0];
    return { offer, rung: rungOf.get(best) ?? null };
}
