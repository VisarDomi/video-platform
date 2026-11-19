import { resolveSegmentUrl, type StreamVariantDescription } from "sdk";

// The site's URL layout. Every edge serves every stream under its own prefix:
//
//   <edge origin>/edge/<edge>/hls/<stream>/master.m3u8
//   <edge origin>/edge/<edge>/hls/<stream>/<variant>/playlist.m3u8
//
// so the same rendition on another edge is the same URL with another edge name. Edges
// number their segments independently; the core stitches copies by program date-time.

const EDGE_IN_PATH = /\/edge\/([^/]+)\/hls\//;
const STREAM_IN_PATH = /\/hls\/([^/]+)\//;

const withoutQuery = (url: string) => url.split("?")[0];

export function edgeOfUrl(url: string): string | null {
    return EDGE_IN_PATH.exec(withoutQuery(url))?.[1] ?? null;
}

export function streamOfUrl(url: string): string | null {
    return STREAM_IN_PATH.exec(withoutQuery(url))?.[1] ?? null;
}

// The same URL on another edge.
export function onEdge(url: string, edge: string): string {
    return url.replace(EDGE_IN_PATH, `/edge/${edge}/hls/`);
}

// One rendition, whichever edge serves it.
export function variantKeyOf(url: string): string {
    return withoutQuery(url).replace(EDGE_IN_PATH, "/edge/*/hls/");
}

export interface MasterVariant extends StreamVariantDescription {
    url: string;
}

// The variants of a master, best first: the one named "source" (the original
// encoding), then by bandwidth.
export function parseVariants(master: string, masterUrl: string): MasterVariant[] {
    const lines = master.split(/\r?\n/);
    const variants: MasterVariant[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
        const uri = lines[i + 1]?.trim();
        if (!uri || uri.startsWith("#")) continue;
        variants.push({
            url: resolveSegmentUrl(masterUrl, uri),
            name: /NAME="([^"]+)"/.exec(line)?.[1] ?? "unnamed",
            resolution: /RESOLUTION=([^,]+)/.exec(line)?.[1] ?? "unknown",
            bandwidth: Number(/BANDWIDTH=(\d+)/.exec(line)?.[1] ?? 0),
            isMasterBest: false,
        });
    }
    variants.sort((a, b) => Number(b.name === "source") - Number(a.name === "source") || b.bandwidth - a.bandwidth);
    if (variants[0]) variants[0].isMasterBest = true;
    return variants;
}
