import * as fs from "fs/promises";
import * as path from "path";
import logger from "../../../common/logger.js";
import {
    AccessFailureContext,
    IDownloadSession,
    IStreamProvider,
    PlaylistFetchFailure,
    StreamVariantDescription,
} from "../../core/interfaces.js";
import { decryptM3u8, getMouflonUrlParams, loadMouflonKeys } from "./mouflonDecoder.js";
import { CDN_FETCH_TIMEOUT_MS } from "../../../common/timing.js";
import { normalizeRecordingId } from "../../download/segmentIdentity.js";

function parseFmp4Duration(data: Buffer): number {
    let pos = 0;
    const trackDurations = new Map<number, number>();

    while (pos + 8 <= data.length) {
        const size = data.readUInt32BE(pos);
        if (size < 8) break;

        const boxType = data.subarray(pos + 4, pos + 8).toString("ascii");
        if (boxType === "sidx" && pos + 40 <= data.length) {
            const version = data[pos + 8];
            if (version === 1) {
                const timescale = data.readUInt32BE(pos + 16);
                const refCount = data.readUInt16BE(pos + 38);
                let offset = pos + 40;
                for (let i = 0; i < refCount; i++) {
                    if (offset + 12 > data.length) break;
                    const ticks = trackDurations.get(timescale) ?? 0;
                    trackDurations.set(timescale, ticks + data.readUInt32BE(offset + 4));
                    offset += 12;
                }
            }
        }
        pos += size;
    }

    if (trackDurations.size === 0) return 0;

    let maxDuration = 0;
    for (const [timescale, ticks] of trackDurations) {
        const duration = ticks / timescale;
        if (duration > maxDuration) maxDuration = duration;
    }
    return Math.round(maxDuration * 1000) / 1000;
}

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const CDN_TLDS = ["org", "com", "net"];
const BULK_BATCH_SIZE = 100;
const ACCESS_DIAGNOSTIC_TIMEOUT_MS = 5_000;

interface ScVariant {
    url: string;
    bandwidth: number;
    name: string;
    resolution: string;
    hasResolution: boolean;
}

function normalizedVariantKey(variantUrl: string): string {
    return variantUrl
        .split("?")[0]
        .replace(/doppiocdn\.(org|com|net)/g, "doppiocdn._");
}

export class ScClient implements IStreamProvider {
    public readonly providerName = "sc";
    private latestStatuses = new Map<string, { status: string; isLive: boolean; statusChangedAt: string }>();
    private latestStatusObservedAt = 0;
    private latestRecordingIds = new Map<string, string>();
    private readonly selectedVariants = new Map<string, StreamVariantDescription>();

    constructor() {
        logger.info("[SC] ScClient initialized.");
    }

    public async init(): Promise<void> {
        await loadMouflonKeys();
    }

    private async fetchApi<T>(url: string, silent = false): Promise<T | null> {
        try {
            const response = await fetch(url, {
                headers: { "User-Agent": USER_AGENT },
                signal: AbortSignal.timeout(CDN_FETCH_TIMEOUT_MS),
            });

            if (!response.ok) {
                if (!silent) logger.warn(`[SC] API returned ${response.status}: ${url}`);
                return null;
            }
            return await response.json() as T;
        } catch (error: any) {
            if (!silent) logger.error(`[SC] API fetch failed: ${url}`, { error: error.message });
            return null;
        }
    }

    private cdnFetchFailCount = 0;

    private async fetchCdn(url: string): Promise<{ ok: boolean; status: number; text: string }> {
        try {
            const response = await fetch(url, {
                headers: { "User-Agent": USER_AGENT },
                signal: AbortSignal.timeout(CDN_FETCH_TIMEOUT_MS),
            });
            if (response.ok && this.cdnFetchFailCount > 0) {
                logger.info(`[SC] CDN fetch recovered after ${this.cdnFetchFailCount} failures`);
                this.cdnFetchFailCount = 0;
            }
            return {
                ok: response.ok,
                status: response.status,
                text: await response.text(),
            };
        } catch (error: any) {
            this.cdnFetchFailCount++;
            if (this.cdnFetchFailCount === 1) {
                logger.error(`[SC] CDN fetch failed: ${url}`, { error: error.message });
            }
            return { ok: false, status: 0, text: "" };
        }
    }

    private async fetchCamData(roomId: string, fallbackUsername: string): Promise<{ roomId: string; username: string; streamName: string; isCamAvailable: boolean; isCamActive: boolean; statusChangedAt: string } | null> {
        const url = `https://stripchat.com/api/front/v2/models/${encodeURIComponent(roomId)}/cam`;
        const data = await this.fetchApi<any>(url);
        if (!data) return null;

        if (!data.user?.user?.id) {
            logger.warn(`[SC] Room ${roomId} returned no user identity`);
            return null;
        }

        const resolvedRoomId = String(data.user.user.id);
        if (resolvedRoomId !== roomId) {
            logger.warn(`[SC] Room identity mismatch: requested=${roomId} resolved=${resolvedRoomId}`);
            return null;
        }

        const currentUsername = data.user.user.username || fallbackUsername;
        const streamName = data.cam?.streamName || roomId;
        const isCamAvailable = data.cam?.isCamAvailable ?? false;
        const isCamActive = data.cam?.isCamActive ?? false;
        const rawStatusChangedAt = String(data.user?.user?.statusChangedAt ?? data.cam?.statusChangedAt ?? "");
        const statusChangedAt = rawStatusChangedAt === "" ? "" : normalizeRecordingId(rawStatusChangedAt);

        return { roomId, username: currentUsername, streamName, isCamAvailable, isCamActive, statusChangedAt };
    }

    public async refreshTarget(roomId: string, fallbackUsername: string): Promise<{ roomId: string; username: string; streamName: string | null; statusChangedAt: string } | null> {
        const result = await this.fetchCamData(roomId, fallbackUsername);
        if (!result) return null;

        if (result.statusChangedAt) this.latestRecordingIds.set(result.roomId, result.statusChangedAt);
        return {
            roomId: result.roomId,
            username: result.username,
            streamName: result.isCamAvailable && result.isCamActive ? result.streamName : null,
            statusChangedAt: result.statusChangedAt,
        };
    }

    public getKnownRecordingId(roomId: string): string | null {
        return this.latestRecordingIds.get(roomId) ?? null;
    }

    public async checkStatusBulk(roomIds: string[]): Promise<Map<string, { status: string; isLive: boolean; statusChangedAt: string }> | null> {
        const result = new Map<string, { status: string; isLive: boolean; statusChangedAt: string }>();

        for (let i = 0; i < roomIds.length; i += BULK_BATCH_SIZE) {
            const batch = roomIds.slice(i, i + BULK_BATCH_SIZE);
            const params = batch.map((id) => `modelIds[]=${id}`).join("&");
            const url = `https://stripchat.com/api/front/models/list?${params}`;

            const data = await this.fetchApi<any>(url, true);
            if (!data?.models) {
                this.bulkFailCount++;
                if (this.bulkFailCount === 1) {
                    logger.warn(`[SC] Bulk status check failed for batch of ${batch.length} streamers — provider state unavailable`);
                }
                return null;
            }

            if (this.bulkFailCount > 0) {
                logger.info(`[SC] Bulk status check recovered after ${this.bulkFailCount} failures`);
                this.bulkFailCount = 0;
            }

            for (const model of data.models) {
                const roomId = String(model.id);
                const next = {
                    status: model.status ?? "unknown",
                    isLive: model.isLive ?? false,
                    statusChangedAt: model.statusChangedAt
                        ? normalizeRecordingId(String(model.statusChangedAt))
                        : "",
                };
                const previous = this.latestStatuses.get(roomId);
                if (previous && (
                    previous.status !== next.status
                    || previous.isLive !== next.isLive
                    || previous.statusChangedAt !== next.statusChangedAt
                )) {
                    logger.info("[SC] STATE_CHANGE", {
                        streamerId: roomId,
                        alias: model.username ?? null,
                        fromStatus: previous.status,
                        toStatus: next.status,
                        fromIsLive: previous.isLive,
                        toIsLive: next.isLive,
                        statusChangedAt: next.statusChangedAt || null,
                    });
                }
                result.set(roomId, next);
            }
        }

        this.latestStatuses = result;
        this.latestStatusObservedAt = Date.now();
        return result;
    }

    private cdnTldIndex = 0;
    private masterFailCounts = new Map<string, number>();
    private bulkFailCount = 0;

    public buildMasterUrl(streamName: string): string {
        const tld = CDN_TLDS[this.cdnTldIndex % CDN_TLDS.length];
        this.cdnTldIndex++;
        return `https://edge-hls.doppiocdn.${tld}/hls/${streamName}/master/${streamName}_auto.m3u8`;
    }

    private parseVariants(content: string, masterUrl: string): ScVariant[] {
        const { pkey } = getMouflonUrlParams(content);
        if (!pkey) return [];

        const lines = content.split("\n");
        const variants: ScVariant[] = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line.startsWith("#EXT-X-STREAM-INF")) continue;

            const nextLine = lines[i + 1]?.trim();
            if (!nextLine || nextLine.startsWith("#")) continue;

            const bwMatch = line.match(/BANDWIDTH=(\d+)/);
            const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;
            const resolution = line.match(/RESOLUTION=([^,]+)/)?.[1] ?? "unknown";
            const name = line.match(/NAME="([^"]+)"/)?.[1] ?? "unnamed";
            const variantUrl = new URL(nextLine, masterUrl).href;
            const separator = variantUrl.includes("?") ? "&" : "?";
            variants.push({
                url: `${variantUrl}${separator}psch=v2&pkey=${pkey}`,
                bandwidth,
                name,
                resolution,
                hasResolution: line.includes("RESOLUTION="),
            });
        }

        return variants;
    }

    private selectBestVariantUrl(content: string, masterUrl: string): string | null {
        const variants = this.parseVariants(content, masterUrl);
        const named = variants.filter((variant) => variant.hasResolution);
        const auto = variants.filter((variant) => !variant.hasResolution);
        const bestNamed = named.sort((a, b) => b.bandwidth - a.bandwidth)[0] ?? null;
        const bestAuto = auto.sort((a, b) => b.bandwidth - a.bandwidth)[0] ?? null;

        const namedCount = named.length;
        const autoCount = auto.length;

        const best = bestNamed ?? bestAuto;
        if (!best) return null;

        if (!bestNamed) {
            logger.warn("[SC] No named variants in master playlist; using best auto variant", {
                autoCount,
                variantPath: new URL(bestAuto!.url).pathname,
                bandwidth: bestAuto!.bandwidth,
            });
        } else {
            logger.debug(`[SC] Master has ${namedCount} named + ${autoCount} auto variants. Best: ${bestNamed.resolution} @ ${bestNamed.bandwidth}bps → ${bestNamed.url.split("?")[0]}`);
        }

        this.selectedVariants.set(normalizedVariantKey(best.url), {
            name: best.name,
            resolution: best.resolution,
            bandwidth: best.bandwidth,
            isMasterBest: true,
        });
        return best.url;
    }

    public describeVariant(url: string): StreamVariantDescription | null {
        return this.selectedVariants.get(normalizedVariantKey(url)) ?? null;
    }

    public async parseMasterPlaylist(masterUrl: string): Promise<string | null> {
        const result = await this.fetchCdn(masterUrl);

        if (!result.ok) {
            const streamMatch = masterUrl.match(/\/hls\/([^/]+)\//);
            const key = streamMatch ? streamMatch[1] : masterUrl;
            const count = (this.masterFailCounts.get(key) ?? 0) + 1;
            this.masterFailCounts.set(key, count);
            if (count === 1) {
                logger.warn(`[SC] Master playlist fetch failed: status=${result.status} url=${masterUrl}`);
            }
            return null;
        }

        const bestUrl = this.selectBestVariantUrl(result.text, masterUrl);
        if (!bestUrl) {
            logger.warn("[SC] No variants or usable Mouflon key in master playlist", {
                masterPath: new URL(masterUrl).pathname,
                responseBytes: Buffer.byteLength(result.text),
            });
            return null;
        }

        const edgeMatch = bestUrl.match(/doppiocdn\.\w+\/(b-hls-\d+)\//);
        const edge = edgeMatch ? edgeMatch[1] : "unknown";
        logger.debug(`[SC] Selected variant: ${bestUrl.split("?")[0]} (edge=${edge})`);
        return bestUrl;
    }

    private async probePlaylist(url: string): Promise<{ status: number; decryptable: boolean; error?: string }> {
        try {
            const response = await fetch(url, {
                headers: { "User-Agent": USER_AGENT },
                signal: AbortSignal.timeout(ACCESS_DIAGNOSTIC_TIMEOUT_MS),
            });
            if (!response.ok) return { status: response.status, decryptable: false };
            const content = await response.text();
            return { status: response.status, decryptable: decryptM3u8(content) !== null };
        } catch (error: any) {
            return { status: 0, decryptable: false, error: error.name ?? "network-error" };
        }
    }

    public async diagnoseAccessFailure(context: AccessFailureContext): Promise<Record<string, unknown>> {
        const observedAt = Date.now();
        const cached = this.latestStatuses.get(context.streamerId);
        const camUrl = `https://stripchat.com/api/front/v2/models/${encodeURIComponent(context.streamerId)}/cam`;
        const camData = await this.fetchApi<any>(camUrl, true);
        const cam = camData?.cam && !Array.isArray(camData.cam) ? camData.cam : null;
        const user = camData?.user?.user ?? null;
        const freshStatus = typeof user?.status === "string" ? user.status : null;
        const freshIsLive = typeof user?.isLive === "boolean" ? user.isLive : null;
        const rawStatusChangedAt = user?.statusChangedAt ?? cam?.statusChangedAt ?? null;

        let masterStatus = 0;
        let variants: ScVariant[] = [];
        try {
            const response = await fetch(context.masterUrl, {
                headers: { "User-Agent": USER_AGENT },
                signal: AbortSignal.timeout(ACCESS_DIAGNOSTIC_TIMEOUT_MS),
            });
            masterStatus = response.status;
            if (response.ok) variants = this.parseVariants(await response.text(), context.masterUrl);
        } catch {
            masterStatus = 0;
        }

        const ordered = [...variants].sort((a, b) => b.bandwidth - a.bandwidth);
        const selected = ordered.find((variant) => normalizedVariantKey(variant.url) === normalizedVariantKey(context.liveUrl))
            ?? ordered[0]
            ?? null;
        const nextLower = selected
            ? ordered.find((variant) => variant.bandwidth < selected.bandwidth) ?? null
            : null;

        let alternateUrl: string | null = null;
        if (selected) {
            const currentTld = selected.url.match(/doppiocdn\.(org|com|net)/)?.[1] ?? null;
            const alternateTld = CDN_TLDS.find((tld) => tld !== currentTld) ?? null;
            if (currentTld && alternateTld) {
                alternateUrl = selected.url.replace(`doppiocdn.${currentTld}`, `doppiocdn.${alternateTld}`);
            }
        }
        const [primaryProbe, alternateProbe, lowerProbe] = await Promise.all([
            selected ? this.probePlaylist(selected.url) : Promise.resolve(null),
            alternateUrl ? this.probePlaylist(alternateUrl) : Promise.resolve(null),
            nextLower ? this.probePlaylist(nextLower.url) : Promise.resolve(null),
        ]);

        const describe = (variant: ScVariant | null) => variant ? {
            name: variant.name,
            resolution: variant.resolution,
            bandwidth: variant.bandwidth,
        } : null;

        return {
            evidenceObservedAt: new Date(observedAt).toISOString(),
            providerState: {
                source: freshStatus ? "fresh-cam" : cached ? "cached-bulk" : "unavailable",
                status: freshStatus ?? cached?.status ?? "unknown",
                isLive: freshIsLive ?? cached?.isLive ?? null,
                camActive: typeof cam?.isCamActive === "boolean" ? cam.isCamActive : null,
                camAvailable: typeof cam?.isCamAvailable === "boolean" ? cam.isCamAvailable : null,
                statusChangedAt: rawStatusChangedAt,
                cachedAgeMs: this.latestStatusObservedAt > 0 ? observedAt - this.latestStatusObservedAt : null,
            },
            master: {
                status: masterStatus,
                variants: ordered.map((variant, index) => ({ ...describe(variant), rank: index + 1 })),
            },
            selected: describe(selected),
            nextLower: describe(nextLower),
            probes: {
                selectedPrimary: primaryProbe,
                selectedAlternateTld: alternateProbe,
                nextLower: lowerProbe,
            },
            behavior: "observe-only",
        };
    }

    public createDownloadSession(): IDownloadSession {
        return new ScDownloadSession();
    }

    public async validateSegment(filePath: string): Promise<{ valid: boolean; duration?: number }> {
        try {
            const data = await fs.readFile(filePath);
            const duration = parseFmp4Duration(data);
            return { valid: true, duration: duration > 0 ? duration : undefined };
        } catch (error: any) {
            logger.warn(`[SC] validateSegment failed for ${filePath}: ${error.message}`);
            return { valid: false };
        }
    }

    public async shouldRetry(context: import("../../core/interfaces.js").DownloadExitContext): Promise<string | null> {
        if (context.exitReason === "aborted") return null;

        const latest = this.latestStatuses.get(context.streamerId);
        if (!latest || latest.status !== "public" || !latest.isLive) {
            return context.lastMasterUrl;
        }
        const lookupAlias = context.lookupAlias ?? context.streamerId;
        const refreshed = await this.refreshTarget(context.streamerId, lookupAlias);
        if (!refreshed?.streamName || refreshed.statusChangedAt !== context.recordingId) {
            return context.lastMasterUrl;
        }

        return this.buildMasterUrl(refreshed.streamName);
    }

    public async recoverVariant(masterPlaylistUrl: string): Promise<string | null> {
        const streamMatch = masterPlaylistUrl.match(/\/hls\/([^/]+)\/master\//);
        if (!streamMatch) return null;
        const streamName = streamMatch[1];

        const attempts = CDN_TLDS.map(async (tld) => {
            const masterUrl = `https://edge-hls.doppiocdn.${tld}/hls/${streamName}/master/${streamName}_auto.m3u8`;
            const variant = await this.parseMasterPlaylist(masterUrl);
            return variant;
        });

        const results = await Promise.allSettled(attempts);

        for (const result of results) {
            if (result.status === "fulfilled" && result.value) {
                return result.value;
            }
        }

        return null;
    }
}

const CDN_HEADERS = { "User-Agent": USER_AGENT };



class ScDownloadSession implements IDownloadSession {
    private lastPlaylistFailure: PlaylistFetchFailure | null = null;

    public async fetchPlaylist(url: string): Promise<string | null> {
        try {
            const response = await fetch(url, {
                headers: CDN_HEADERS,
                signal: AbortSignal.timeout(CDN_FETCH_TIMEOUT_MS),
            });

            if (!response.ok) {
                this.lastPlaylistFailure = { kind: "http", status: response.status };
                return null;
            }

            const text = await response.text();
            const decrypted = decryptM3u8(text);
            if (!decrypted) {
                this.lastPlaylistFailure = { kind: "decrypt" };
                return null;
            }
            this.lastPlaylistFailure = null;
            return decrypted;
        } catch (error: any) {
            this.lastPlaylistFailure = { kind: "network", error: error.name ?? "network-error" };
            return null;
        }
    }

    public getLastPlaylistFailure(): PlaylistFetchFailure | null {
        return this.lastPlaylistFailure ? { ...this.lastPlaylistFailure } : null;
    }

    public async fetchSegment(tsUrl: string): Promise<import("../../core/interfaces.js").SegmentFetchResult> {
        try {
            const response = await fetch(tsUrl, {
                headers: CDN_HEADERS,
                signal: AbortSignal.timeout(CDN_FETCH_TIMEOUT_MS),
            });
            if (response.ok) {
                const buf = await response.arrayBuffer();
                return { data: Buffer.from(buf) };
            }
            return { data: null, retryable: false, status: response.status };
        } catch (error: any) {
            return { data: null, retryable: true, error: error.name ?? "network-error" };
        }
    }
}
