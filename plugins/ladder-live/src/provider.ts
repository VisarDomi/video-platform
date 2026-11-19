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
import type { LadderApi, LiveChannel } from "./api.js";
import type { LadderConfig } from "./config.js";
import { latencyName, modeOfUrl, parseLadder, qualityOf, selectPlaylist } from "./ladder.js";

// How long one reading of the channel list answers "has this stream ended?".
const STREAM_STATE_TTL_MS = 2_000;

export type StreamState = "live" | "paid" | "ended" | "unknown";

interface StreamRecord {
    channelId: string;
    recordingId: string;
    variant: StreamVariantDescription;
}

const withoutQuery = (url: string) => url.split("?")[0];

// The protocol side. A capture's playlist is the media playlist of the selected mode,
// handed out by the control channel; the site serves one copy of each stream, so there
// is no copy failover. The site answers 403 for a playlist both while a stream is paid
// and once it has ended: the channel list tells the two apart, and an ended stream ends
// the recording at once (PlaylistNotFoundError) instead of waiting for the core's
// offline confirmation.
export class LadderProvider implements IStreamProvider {
    public readonly providerName: string;
    public readonly playlistRetryMs: number;
    // The channel list as of the latest lookup, for shouldRetry.
    private latest = new Map<string, LiveChannel>();
    private readonly streams = new Map<string, StreamRecord>();
    private stateReading: { at: number; result: Promise<Map<string, LiveChannel> | null> } | null = null;

    constructor(
        siteId: string,
        private readonly api: LadderApi,
        private readonly config: LadderConfig,
        private readonly log: Logger,
    ) {
        this.providerName = siteId;
        this.playlistRetryMs = config.playlistRetryMs;
    }

    public noteChannelList(channels: Map<string, LiveChannel>): void {
        this.latest = channels;
    }

    // Opens the channel's stream and selects the playlist to capture; null when it
    // cannot start now (logged).
    public async openStream(channelId: string, recordingId: string): Promise<string | null> {
        const offer = await this.api.openStream(channelId);
        if (!offer) return null;
        const master = await this.api.fetchText(offer.master);
        const rungs = master?.status === 200 ? parseLadder(master.text, offer.master) : [];
        const selection = selectPlaylist(offer.playlists, rungs, this.config);
        if (!selection) {
            this.log.warn(`Channel ${channelId}: no playlist within the quality limits`, { offered: offer.playlists.map((p) => p.mode) });
            return null;
        }
        const { offer: chosen, rung } = selection;
        this.log.debug(`Channel ${channelId}: selected mode ${chosen.mode} (quality ${qualityOf(chosen.mode)}, ${latencyName(chosen.mode)} latency)`
            + (rung ? ` ${rung.width}x${rung.height} @ ${rung.bandwidth}bps` : ""), { offered: offer.playlists.map((p) => p.mode) });
        this.streams.set(withoutQuery(chosen.url), {
            channelId,
            recordingId,
            variant: {
                name: `mode ${chosen.mode}`,
                resolution: rung ? `${rung.width}x${rung.height}` : "unknown",
                bandwidth: rung?.bandwidth ?? 0,
                isMasterBest: rung !== null && rung === rungs[0],
            },
        });
        return chosen.url;
    }

    // A media playlist is captured as it is; a master gives its best rung within the
    // height cap.
    public async parseMasterPlaylist(url: string): Promise<string | null> {
        if (modeOfUrl(url) !== null) return url;
        const master = await this.api.fetchText(url);
        if (!master || master.status !== 200) {
            this.log.debug(`Master playlist unavailable: status=${master?.status ?? "network"} url=${withoutQuery(url)}`);
            return null;
        }
        const rungs = parseLadder(master.text, url)
            .filter((rung) => this.config.maxHeight === null || (rung.height > 0 && rung.height <= this.config.maxHeight));
        return rungs[0]?.url ?? null;
    }

    public describeVariant(url: string): StreamVariantDescription | null {
        return this.streams.get(withoutQuery(url))?.variant ?? null;
    }

    // Whether the stream behind a playlist URL is still live, by a fresh reading of the
    // channel list (shared by concurrent requests for a moment).
    public async streamState(playlistUrl: string): Promise<StreamState> {
        const stream = this.streams.get(withoutQuery(playlistUrl));
        if (!stream) return "unknown";
        if (!this.stateReading || Date.now() - this.stateReading.at > STREAM_STATE_TTL_MS) {
            this.stateReading = { at: Date.now(), result: this.api.liveChannels() };
        }
        const channels = await this.stateReading.result;
        if (!channels) return "unknown";
        const channel = channels.get(stream.channelId);
        if (!channel || channel.startedAt !== stream.recordingId) return "ended";
        return channel.paid ? "paid" : "live";
    }

    public async validateSegment(filePath: string): Promise<SegmentValidationResult> {
        try {
            const stats = await fs.stat(filePath);
            if (stats.size <= 0) return { valid: false };
            const dimensions = await probeSegmentDimensions(filePath);
            if (!dimensions) this.log.warn(`Unknown segment dimensions; retaining with an input boundary: ${filePath}`);
            return { valid: true, dimensions };
        } catch {
            return { valid: false };
        }
    }

    public createDownloadSession(): IDownloadSession {
        return new LadderSession(this, this.api.headers);
    }

    // One copy of every stream: nothing to fail over to.
    public async recoverVariant(_masterPlaylistUrl: string): Promise<string | null> {
        return null;
    }

    // After an attempt ended without the stream ending: the same broadcast, still live
    // and free, gets a fresh handshake; anything else keeps the previous URL (the core's
    // offline confirmation decides).
    public async shouldRetry(context: DownloadExitContext): Promise<string | null> {
        if (context.exitReason === "aborted") return null;
        const channel = this.latest.get(context.streamerId);
        if (!channel || channel.paid || channel.startedAt !== context.recordingId) return context.lastMasterUrl;
        const url = await this.openStream(context.streamerId, context.recordingId);
        if (!url) {
            this.log.warn(`${context.streamerId}: stream refresh failed; retaining the previous URL`);
            return context.lastMasterUrl;
        }
        return url;
    }
}

class LadderSession implements IDownloadSession {
    private lastFailure: PlaylistFetchFailure | null = null;

    constructor(private readonly provider: LadderProvider, private readonly headers: Record<string, string>) {}

    public getLastPlaylistFailure(): PlaylistFetchFailure | null {
        return this.lastFailure ? { ...this.lastFailure } : null;
    }

    public async fetchPlaylist(url: string, signal?: AbortSignal): Promise<string | null> {
        let response: Response;
        try {
            response = await fetch(url, { headers: this.headers, signal: requestSignal(CDN_FETCH_TIMEOUT_MS, signal) });
        } catch (error: any) {
            if (signal?.aborted) return null;
            this.lastFailure = { kind: "network", error: error?.name ?? "network-error" };
            return null;
        }
        if (response.ok) {
            const text = await response.text().catch(() => null);
            if (text === null) {
                if (!signal?.aborted) this.lastFailure = { kind: "network", error: "body" };
                return null;
            }
            this.lastFailure = null;
            return text;
        }
        await response.body?.cancel().catch(() => {});
        // 403 is the site's answer for a paid stream and for an ended one alike.
        if (response.status === 403 && await this.provider.streamState(url) === "ended") throw new PlaylistNotFoundError(url);
        this.lastFailure = { kind: "http", status: response.status };
        return null;
    }

    public async fetchSegment(url: string, signal?: AbortSignal): Promise<SegmentFetchResult> {
        try {
            const response = await fetch(url, { headers: this.headers, signal: requestSignal(CDN_FETCH_TIMEOUT_MS, signal) });
            if (response.ok) return { data: Buffer.from(await response.arrayBuffer()) };
            await response.body?.cancel().catch(() => {});
            // Rate limits and server errors pass; any other status will not change.
            return { data: null, retryable: response.status === 429 || response.status >= 500, status: response.status };
        } catch (error: any) {
            return { data: null, retryable: true, error: error?.name ?? "network-error" };
        }
    }
}
