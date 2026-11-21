import { promises as fs } from "node:fs";
import {
    CDN_FETCH_TIMEOUT_MS,
    PlaylistNotFoundError,
    probeSegmentDimensions,
    requestSignal,
    type DownloadExitContext,
    type IDownloadSession,
    type IStreamProvider,
    type Logger,
    type PlaylistFetchFailure,
    type SegmentFetchResult,
    type SegmentValidationResult,
    type StreamVariantDescription,
} from "sdk";
import type { LiveStream } from "./api.js";
import type { TsLiveConfig } from "./config.js";
import { headersForTokens, type Tokens } from "./tokens.js";

interface Variant {
    url: string;
    width: number;
    height: number;
    bandwidth: number;
}

// The variants of a master playlist, best first (pixels, then bandwidth).
export function parseVariants(body: string, masterUrl: string): Variant[] {
    const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const variants: Variant[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
        const uri = lines[i + 1];
        if (!uri || uri.startsWith("#")) continue;
        const resolution = lines[i].match(/RESOLUTION=(\d+)x(\d+)/);
        const bandwidth = lines[i].match(/[:,]BANDWIDTH=(\d+)/);
        variants.push({
            // The site ends variant URIs with a stray "&".
            url: new URL(uri.replace(/&$/, ""), masterUrl).href,
            width: resolution ? Number(resolution[1]) : 0,
            height: resolution ? Number(resolution[2]) : 0,
            bandwidth: bandwidth ? Number(bandwidth[1]) : 0,
        });
    }
    return variants.sort((a, b) => b.width * b.height - a.width * a.height || b.bandwidth - a.bandwidth);
}

// The protocol side. A stream is account-gated: its master and media playlists need the
// stream tokens (about ten seconds; the auth daemon renews them), its segments need none.
// The site lists the variants lowest first; the best one is captured. A playlist that
// answers 404 belongs to a stream that ended. One copy of every stream: no failover.
export class TsLiveProvider implements IStreamProvider {
    public readonly providerName: string;
    public readonly refreshMasterDuringDownload = false;
    public readonly playlistRetryMs: number;
    // The latest lookup's live streams, for shouldRetry.
    private latest = new Map<string, LiveStream>();
    private readonly variants = new Map<string, StreamVariantDescription>();

    constructor(siteId: string, private readonly tokens: () => Promise<Tokens>, config: TsLiveConfig, private readonly log: Logger) {
        this.providerName = siteId;
        this.playlistRetryMs = config.playlistRetryMs;
    }

    public noteLookup(live: Map<string, LiveStream>): void {
        this.latest = live;
    }

    private async streamHeaders(): Promise<Record<string, string>> {
        return headersForTokens(await this.tokens(), "stream");
    }

    public async parseMasterPlaylist(masterUrl: string): Promise<string | null> {
        let response: Response;
        try {
            response = await fetch(masterUrl, { headers: await this.streamHeaders(), signal: requestSignal(CDN_FETCH_TIMEOUT_MS) });
        } catch (error: any) {
            this.log.debug(`Master playlist unavailable: ${error?.message} url=${masterUrl}`);
            return null;
        }
        if (!response.ok) {
            // A master that answers 404 just as a stream starts is asked again by the core.
            this.log.debug(`Master playlist unavailable: status=${response.status} url=${masterUrl}`);
            return null;
        }
        const body = await response.text();
        const variants = parseVariants(body, masterUrl);
        const best = variants[0];
        if (best) {
            this.variants.set(best.url, {
                name: `${best.height}p`,
                resolution: best.width ? `${best.width}x${best.height}` : "unknown",
                bandwidth: best.bandwidth,
                isMasterBest: true,
            });
            return best.url;
        }
        // A stream with a single rendition serves its media playlist as the master.
        if (body.includes("#EXTINF:")) return masterUrl;
        this.log.warn(`No playable variant in master playlist: ${masterUrl}`);
        return null;
    }

    public describeVariant(url: string): StreamVariantDescription | null {
        return this.variants.get(url) ?? null;
    }

    public async validateSegment(filePath: string): Promise<SegmentValidationResult> {
        try {
            const stats = await fs.stat(filePath);
            if (stats.size <= 0) return { valid: false };
        } catch {
            return { valid: false };
        }
        const dimensions = await probeSegmentDimensions(filePath);
        if (!dimensions) this.log.warn(`Unknown segment dimensions; retaining with an input boundary: ${filePath}`);
        return { valid: true, dimensions };
    }

    public createDownloadSession(): IDownloadSession {
        return new TsLiveSession(() => this.streamHeaders(), this.log);
    }

    public async recoverVariant(_masterPlaylistUrl: string): Promise<string | null> {
        return null;
    }

    // After an attempt ended without the stream ending: the same stream, still live in
    // the latest lookup, is opened again from its master; anything else keeps the last
    // URL (the core's offline confirmation decides).
    public async shouldRetry(context: DownloadExitContext): Promise<string | null> {
        if (context.exitReason === "aborted") return null;
        const stream = this.latest.get(context.streamerId);
        return stream?.streamId === context.recordingId ? stream.masterUrl : context.lastMasterUrl;
    }
}

class TsLiveSession implements IDownloadSession {
    // A run of 401s is logged when it starts and when it ends, not at every retry.
    private unauthorized = 0;
    private lastFailure: PlaylistFetchFailure | null = null;

    constructor(private readonly headers: () => Promise<Record<string, string>>, private readonly log: Logger) {}

    public getLastPlaylistFailure(): PlaylistFetchFailure | null {
        return this.lastFailure;
    }

    public async fetchPlaylist(url: string, signal?: AbortSignal): Promise<string | null> {
        this.lastFailure = null;
        let response: Response;
        try {
            response = await fetch(url, { headers: await this.headers(), signal: requestSignal(CDN_FETCH_TIMEOUT_MS, signal) });
        } catch (error: any) {
            if (signal?.aborted) return null;
            this.lastFailure = { kind: "network", error: error?.message };
            this.log.debug(`Playlist fetch error: ${error?.message} url=${url}`);
            return null;
        }
        if (response.status === 404) throw new PlaylistNotFoundError(url);
        if (!response.ok) {
            this.lastFailure = { kind: "http", status: response.status };
            if (response.status === 401) {
                const body = await response.json().catch(() => null) as { reason?: unknown } | null;
                if (this.unauthorized++ === 0) this.log.warn(`Playlist 401 (stream token ${body?.reason ?? "rejected"}) url=${url}`);
            } else {
                this.log.debug(`Playlist fetch failed: status=${response.status} url=${url}`);
            }
            return null;
        }
        if (this.unauthorized > 0) {
            this.log.info(`Playlist authorized again after ${this.unauthorized} 401 answer(s) url=${url}`);
            this.unauthorized = 0;
        }
        return await response.text();
    }

    public async fetchSegment(url: string, signal?: AbortSignal): Promise<SegmentFetchResult> {
        try {
            const response = await fetch(url, { signal: requestSignal(CDN_FETCH_TIMEOUT_MS, signal) });
            if (response.ok) return { data: Buffer.from(await response.arrayBuffer()) };
            this.log.debug(`Segment download failed: status=${response.status}`, { url });
            // 429 asks to retry later; any other HTTP error ends the attempt.
            return { data: null, retryable: response.status === 429, status: response.status };
        } catch (error: any) {
            this.log.debug(`Segment fetch error: ${error?.message}`, { url });
            return { data: null, retryable: true, error: error?.message };
        }
    }
}
