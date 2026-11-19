import { promises as fs } from "node:fs";
import {
    CDN_FETCH_TIMEOUT_MS,
    dropZeroSizeSamples,
    inspectFragment,
    PlaylistNotFoundError,
    requestSignal,
    type AccessFailureContext,
    type DownloadExitContext,
    type IDownloadSession,
    type IStreamProvider,
    type Logger,
    type PlaylistFetchFailure,
    type SegmentFetchResult,
    type SegmentValidationResult,
    type StreamVariantDescription,
} from "sdk";
import type { ChannelStatus, Fmp4Api, StreamInfo } from "./api.js";
import type { Fmp4Config } from "./config.js";
import { edgeOfUrl, onEdge, parseVariants, streamOfUrl, variantKeyOf } from "./edges.js";
import { decodePlaylist } from "./playlistCipher.js";
import { fragmentDurationS } from "./fragment.js";

// How long one reading of a channel's stream answers "has this stream ended?".
const STREAM_STATE_TTL_MS = 2_000;
// Evidence requests are short: they run beside capture, never in its way.
const DIAGNOSTIC_TIMEOUT_MS = 5_000;

interface StreamRecord {
    channelId: string;
    recordingId: string;
    edges: string[];
}

export interface OpenedStream {
    alias: string;
    recordingId: string;
    masterUrl: string;
}

// The protocol side. Every stream is served by several edges (copies) that number
// their segments independently; the plug-in names the copy a URL belongs to (edgeOf),
// tells renditions apart regardless of edge (variantKey) and finds another copy when
// one fails (recoverVariant), preferring edges that have not failed lately. Switching
// and stitching are the core's. Media playlists may be obfuscated (playlistCipher.ts);
// fragments with zero-size sample entries are repaired with the SDK toolkit.
export class Fmp4Provider implements IStreamProvider {
    public readonly providerName: string;
    public readonly playlistRetryMs: number;
    private latest = new Map<string, ChannelStatus>();
    private latestAt = 0;
    private readonly streams = new Map<string, StreamRecord>();
    private readonly edgeFailures = new Map<string, number>();
    private readonly variants = new Map<string, StreamVariantDescription>();
    private readonly keyWarnings = new Set<string>();
    private readonly streamReadings = new Map<string, { at: number; result: Promise<StreamInfo | null> }>();

    constructor(
        siteId: string,
        private readonly api: Fmp4Api,
        private readonly config: Fmp4Config,
        private readonly log: Logger,
    ) {
        this.providerName = siteId;
        this.playlistRetryMs = config.playlistRetryMs;
    }

    public noteStatuses(statuses: Map<string, ChannelStatus>): void {
        this.latest = statuses;
        this.latestAt = Date.now();
    }

    // ---- copies --------------------------------------------------------------------

    public edgeOf(url: string): string | null {
        return edgeOfUrl(url);
    }

    public variantKey(url: string): string {
        return variantKeyOf(url);
    }

    public noteEdgeFailure(url: string): void {
        const stream = streamOfUrl(url), edge = edgeOfUrl(url);
        if (stream && edge) this.edgeFailures.set(`${stream}|${edge}`, Date.now());
    }

    // Edges in failover order: those without a recent failure first (in the site's
    // order), then the others, the longest-failed first.
    public edgeOrder(stream: string, edges: readonly string[]): string[] {
        const failedAt = (edge: string) => {
            const at = this.edgeFailures.get(`${stream}|${edge}`) ?? 0;
            return Date.now() - at > this.config.edgeFailureMemoryMs ? 0 : at;
        };
        return edges.map((edge, index) => ({ edge, index, at: failedAt(edge) }))
            .sort((a, b) => a.at - b.at || a.index - b.index)
            .map(({ edge }) => edge);
    }

    // The channel's current stream on its healthiest edge; null when it has none to
    // play now (logged).
    public async openStream(channelId: string): Promise<OpenedStream | null> {
        let info: StreamInfo | null;
        try {
            info = await this.api.stream(channelId);
        } catch (error: any) {
            this.log.warn(`Stream API unavailable for channel ${channelId}`, { error: error?.message });
            return null;
        }
        if (!info) {
            this.log.warn(`Channel ${channelId} no longer exists`);
            return null;
        }
        const edges = info.edges.filter((edge) => info!.masterUrls[edge]);
        if (!info.available || !info.active || !info.streamName || edges.length === 0) {
            this.log.debug(`Channel ${channelId} has no playable stream (available=${info.available} active=${info.active} edges=${edges.length})`);
            return null;
        }
        this.streams.set(info.streamName, { channelId, recordingId: info.statusSince, edges });
        const edge = this.edgeOrder(info.streamName, edges)[0];
        return { alias: info.name, recordingId: info.statusSince, masterUrl: info.masterUrls[edge] };
    }

    public async parseMasterPlaylist(masterUrl: string): Promise<string | null> {
        let text: string;
        try {
            const response = await fetch(masterUrl, { headers: this.api.headers, signal: requestSignal(CDN_FETCH_TIMEOUT_MS) });
            if (!response.ok) {
                await response.body?.cancel().catch(() => {});
                this.noteEdgeFailure(masterUrl);
                this.log.debug(`Master playlist unavailable: status=${response.status} edge=${edgeOfUrl(masterUrl) ?? "unknown"}`);
                return null;
            }
            text = await response.text();
        } catch (error: any) {
            this.noteEdgeFailure(masterUrl);
            this.log.debug(`Master playlist unavailable: ${error?.name ?? "network error"} edge=${edgeOfUrl(masterUrl) ?? "unknown"}`);
            return null;
        }
        const best = parseVariants(text, masterUrl)[0];
        if (!best) {
            this.log.warn("Master playlist lists no variants", { edge: edgeOfUrl(masterUrl) });
            return null;
        }
        const { url, ...description } = best;
        this.variants.set(variantKeyOf(url), description);
        return url;
    }

    // Another copy of the stream when the current one fails: the master of each other
    // edge, healthiest first; the first that answers gives the variant.
    public async recoverVariant(masterPlaylistUrl: string): Promise<string | null> {
        const stream = streamOfUrl(masterPlaylistUrl);
        const current = edgeOfUrl(masterPlaylistUrl);
        if (!stream || !current) return null;
        const edges = this.streams.get(stream)?.edges ?? [current];
        for (const edge of this.edgeOrder(stream, edges)) {
            const variant = await this.parseMasterPlaylist(onEdge(masterPlaylistUrl, edge));
            if (variant) return variant;
        }
        return null;
    }

    public describeVariant(url: string): StreamVariantDescription | null {
        return this.variants.get(variantKeyOf(url)) ?? null;
    }

    // ---- sessions --------------------------------------------------------------------

    public decode(text: string): string | null {
        const result = decodePlaylist(text, this.config.playlistKeys);
        if (result.ok) return result.text;
        const key = `${result.keyId}|${result.reason}`;
        if (!this.keyWarnings.has(key)) {
            this.keyWarnings.add(key);
            this.log.warn(`Cannot decode playlists with key ${result.keyId ?? "(none)"}: ${result.reason}`);
        }
        return null;
    }

    // Whether the stream behind a URL is still the channel's current one.
    public async streamState(url: string): Promise<"live" | "ended" | "unknown"> {
        const stream = streamOfUrl(url);
        const record = stream ? this.streams.get(stream) : undefined;
        if (!stream || !record) return "unknown";
        let reading = this.streamReadings.get(record.channelId);
        if (!reading || Date.now() - reading.at > STREAM_STATE_TTL_MS) {
            reading = { at: Date.now(), result: this.api.stream(record.channelId).catch(() => null) };
            this.streamReadings.set(record.channelId, reading);
        }
        const info = await reading.result.catch(() => null);
        if (info === null) return "unknown";
        return info.active && info.streamName === stream ? "live" : "ended";
    }

    public createDownloadSession(): IDownloadSession {
        return new Fmp4Session(this, this.api.headers);
    }

    public async validateSegment(filePath: string): Promise<SegmentValidationResult> {
        try {
            const data = await fs.readFile(filePath);
            // Players and ffmpeg refuse a fragment whose index points outside its data or
            // lists an empty frame the session could not drop.
            const { zeroSizeSamples, problem } = inspectFragment(data);
            if (problem !== null || zeroSizeSamples > 0) {
                this.log.warn(`Fragment index damaged: ${problem ?? `${zeroSizeSamples} zero-size sample entries`}: ${filePath}`);
                return { valid: false };
            }
            const duration = fragmentDurationS(data);
            return { valid: true, ...(duration ? { duration } : {}) };
        } catch (error: any) {
            this.log.warn(`validateSegment failed for ${filePath}: ${error?.message}`);
            return { valid: false };
        }
    }

    // After an attempt ended without the stream ending: while the channel is still
    // public with the same identity, start again from its healthiest edge.
    public async shouldRetry(context: DownloadExitContext): Promise<string | null> {
        if (context.exitReason === "aborted") return null;
        const status = this.latest.get(context.streamerId);
        if (!status || status.status !== "public" || !status.live || status.statusSince !== context.recordingId) {
            return context.lastMasterUrl;
        }
        const opened = await this.openStream(context.streamerId);
        if (!opened || opened.recordingId !== context.recordingId) return context.lastMasterUrl;
        return opened.masterUrl;
    }

    // Evidence for an access incident: what the site says about the channel now, and how
    // every edge answers for the master and the selected variant. Observe-only: nothing
    // here changes what the capture does.
    public async diagnoseAccessFailure(context: AccessFailureContext): Promise<Record<string, unknown>> {
        const observedAt = Date.now();
        const cached = this.latest.get(context.streamerId) ?? null;
        const [fresh, stream] = await Promise.all([
            this.api.statuses([context.streamerId]).then((statuses) => statuses?.get(context.streamerId) ?? null).catch(() => null),
            this.api.stream(context.streamerId, DIAGNOSTIC_TIMEOUT_MS).catch(() => undefined),
        ]);
        const streamName = streamOfUrl(context.liveUrl);
        const edges = (streamName ? this.streams.get(streamName)?.edges : undefined) ?? stream?.edges ?? [];
        const probe = async (url: string, decode: boolean) => {
            try {
                const response = await fetch(url, { headers: this.api.headers, signal: requestSignal(DIAGNOSTIC_TIMEOUT_MS) });
                const text = response.ok ? await response.text() : (await response.body?.cancel().catch(() => {}), "");
                return { status: response.status, ...(decode && response.ok ? { decodable: decodePlaylist(text, this.config.playlistKeys).ok } : {}) };
            } catch (error: any) {
                return { status: 0, error: error?.name ?? "network-error" };
            }
        };
        const perEdge = await Promise.all(edges.map(async (edge) => ({
            edge,
            master: await probe(onEdge(context.masterUrl, edge), false),
            variant: await probe(onEdge(context.liveUrl, edge), true),
        })));
        return {
            evidenceObservedAt: new Date(observedAt).toISOString(),
            providerState: {
                source: fresh ? "fresh-status" : cached ? "cached-status" : "unavailable",
                status: (fresh ?? cached)?.status ?? "unknown",
                live: (fresh ?? cached)?.live ?? null,
                statusSince: (fresh ?? cached)?.statusSince ?? null,
                cachedAgeMs: this.latestAt > 0 ? observedAt - this.latestAt : null,
            },
            stream: stream === undefined ? "unavailable" : stream === null ? "no such channel" : {
                current: stream.streamName === streamName, available: stream.available, active: stream.active,
            },
            failingEdge: edgeOfUrl(context.liveUrl),
            edges: perEdge,
            behavior: "observe-only",
        };
    }
}

class Fmp4Session implements IDownloadSession {
    private lastFailure: PlaylistFetchFailure | null = null;

    constructor(private readonly provider: Fmp4Provider, private readonly headers: Record<string, string>) {}

    public getLastPlaylistFailure(): PlaylistFetchFailure | null {
        return this.lastFailure ? { ...this.lastFailure } : null;
    }

    public async fetchPlaylist(url: string, signal?: AbortSignal): Promise<string | null> {
        let response: Response;
        try {
            response = await fetch(url, { headers: this.headers, signal: requestSignal(CDN_FETCH_TIMEOUT_MS, signal) });
        } catch (error: any) {
            if (signal?.aborted) return null;
            this.provider.noteEdgeFailure(url);
            this.lastFailure = { kind: "network", error: error?.name ?? "network-error" };
            return null;
        }
        if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            // A stream that is no longer the channel's current one is gone for good.
            if (response.status === 404 && await this.provider.streamState(url) === "ended") throw new PlaylistNotFoundError(url);
            this.provider.noteEdgeFailure(url);
            this.lastFailure = { kind: "http", status: response.status };
            return null;
        }
        const text = await response.text().catch(() => null);
        if (text === null) {
            if (!signal?.aborted) this.lastFailure = { kind: "network", error: "body" };
            return null;
        }
        const decoded = this.provider.decode(text);
        if (decoded === null) {
            this.lastFailure = { kind: "decrypt" };
            return null;
        }
        this.lastFailure = null;
        return decoded;
    }

    public async fetchSegment(url: string, signal?: AbortSignal): Promise<SegmentFetchResult> {
        try {
            const response = await fetch(url, { headers: this.headers, signal: requestSignal(CDN_FETCH_TIMEOUT_MS, signal) });
            if (!response.ok) {
                await response.body?.cancel().catch(() => {});
                this.provider.noteEdgeFailure(url);
                // A rate limit passes; any other status is this copy's, and the session
                // starts again from a healthy one.
                return { data: null, retryable: response.status === 429, status: response.status };
            }
            const data = Buffer.from(await response.arrayBuffer());
            // An empty frame entry left by a source stall carries no media; dropping it
            // keeps every byte and lets players read the fragment.
            const repair = dropZeroSizeSamples(data);
            if (!repair) return { data };
            return { data: repair.data, repair: `dropped ${repair.droppedSamples} zero-size sample entr${repair.droppedSamples === 1 ? "y" : "ies"}` };
        } catch (error: any) {
            if (!signal?.aborted) this.provider.noteEdgeFailure(url);
            return { data: null, retryable: true, error: error?.name ?? "network-error" };
        }
    }
}
