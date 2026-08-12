import * as fs from "fs/promises";
import * as path from "path";
import logger from "../../../common/logger.js";
import { IDownloadSession, IStreamProvider } from "../../core/interfaces.js";
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

export class ScClient implements IStreamProvider {
    public readonly providerName = "sc";
    private latestStatuses = new Map<string, { status: string; isLive: boolean; statusChangedAt: string }>();
    private latestRecordingIds = new Map<string, string>();

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

    private static uniq(length = 16): string {
        const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
        let result = "";
        for (let i = 0; i < length; i++) {
            result += chars[Math.floor(Math.random() * chars.length)];
        }
        return result;
    }

    private async fetchCamData(username: string): Promise<{ roomId: string; username: string; streamName: string; isCamAvailable: boolean; isCamActive: boolean; statusChangedAt: string } | null> {
        const url = `https://stripchat.com/api/front/v2/models/username/${username}/cam?uniq=${ScClient.uniq()}`;
        const data = await this.fetchApi<any>(url);
        if (!data) return null;

        if (!data.user?.user?.id) {
            if (data.error === "Not Found") {
                logger.warn(`[SC] User ${username} not found`);
            }
            return null;
        }

        const roomId = String(data.user.user.id);
        const currentUsername = data.user.user.username || username;
        const streamName = data.cam?.streamName || roomId;
        const isCamAvailable = data.cam?.isCamAvailable ?? false;
        const isCamActive = data.cam?.isCamActive ?? false;
        const rawStatusChangedAt = String(data.user?.user?.statusChangedAt ?? data.cam?.statusChangedAt ?? "");
        const statusChangedAt = rawStatusChangedAt === "" ? "" : normalizeRecordingId(rawStatusChangedAt);

        return { roomId, username: currentUsername, streamName, isCamAvailable, isCamActive, statusChangedAt };
    }

    public async refreshStreamName(username: string): Promise<string | null> {
        const result = await this.fetchCamData(username);
        if (!result) return null;

        if (!result.isCamAvailable || !result.isCamActive) {
            logger.debug(`[SC] ${username}: cam not ready (available=${result.isCamAvailable}, active=${result.isCamActive})`);
            return null;
        }

        return result.streamName;
    }

    public async refreshTarget(username: string): Promise<{ roomId: string; username: string; streamName: string | null; statusChangedAt: string } | null> {
        const result = await this.fetchCamData(username);
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
                result.set(String(model.id), {
                    status: model.status ?? "unknown",
                    isLive: model.isLive ?? false,
                    statusChangedAt: model.statusChangedAt
                        ? normalizeRecordingId(String(model.statusChangedAt))
                        : "",
                });
            }
        }

        this.latestStatuses = result;
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

    private selectBestVariantUrl(content: string, masterUrl: string): string | null {
        const { pkey } = getMouflonUrlParams(content);
        if (!pkey) return null;

        const lines = content.split("\n");
        let bestNamed: { url: string; bandwidth: number } | null = null;
        let bestAuto: { url: string; bandwidth: number } | null = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line.startsWith("#EXT-X-STREAM-INF")) continue;

            const nextLine = lines[i + 1]?.trim();
            if (!nextLine || nextLine.startsWith("#")) continue;

            const bwMatch = line.match(/BANDWIDTH=(\d+)/);
            const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;
            const hasResolution = line.includes("RESOLUTION=");
            const isSource = line.includes('NAME="source"');

            if (hasResolution && !isSource) {
                if (!bestNamed || bandwidth > bestNamed.bandwidth) {
                    bestNamed = { url: nextLine, bandwidth };
                }
            } else {
                if (!bestAuto || bandwidth > bestAuto.bandwidth) {
                    bestAuto = { url: nextLine, bandwidth };
                }
            }
        }

        const namedCount = lines.filter(l => l.trim().startsWith("#EXT-X-STREAM-INF") && l.includes("RESOLUTION=")).length;
        const autoCount = lines.filter(l => l.trim().startsWith("#EXT-X-STREAM-INF") && !l.includes("RESOLUTION=")).length;

        const best = bestNamed ?? bestAuto;
        if (!best) return null;

        if (!bestNamed) {
            logger.warn(`[SC] No named variants in master playlist (auto=${autoCount}), falling back to auto variant: ${bestAuto!.url}`);
        } else {
            const resMatch = lines.find(l => l.includes(`BANDWIDTH=${bestNamed!.bandwidth}`) && l.includes("RESOLUTION="))?.match(/RESOLUTION=(\S+)/);
            const res = resMatch ? resMatch[1].replace(/,.*/, "") : "unknown";
            logger.debug(`[SC] Master has ${namedCount} named + ${autoCount} auto variants. Best: ${res} @ ${bestNamed.bandwidth}bps → ${bestNamed.url}`);
        }

        const variantUrl = new URL(best.url, masterUrl).href;
        const separator = variantUrl.includes("?") ? "&" : "?";
        return `${variantUrl}${separator}psch=v2&pkey=${pkey}`;
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
            logger.warn(`[SC] No variants/mouflon key in master playlist: url=${masterUrl} body=${result.text.slice(0, 500)}`);
            return null;
        }

        const edgeMatch = bestUrl.match(/doppiocdn\.\w+\/(b-hls-\d+)\//);
        const edge = edgeMatch ? edgeMatch[1] : "unknown";
        logger.debug(`[SC] Selected variant: ${bestUrl.split("?")[0]} (edge=${edge})`);
        return bestUrl;
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
        const refreshed = await this.refreshTarget(lookupAlias);
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
    private playlistFailCount = 0;
    private lastPlaylistFailStatus = 0;

    public async fetchPlaylist(url: string): Promise<string | null> {
        try {
            const response = await fetch(url, {
                headers: CDN_HEADERS,
                signal: AbortSignal.timeout(CDN_FETCH_TIMEOUT_MS),
            });

            if (!response.ok) {
                this.playlistFailCount++;
                if (response.status !== this.lastPlaylistFailStatus) {
                    logger.warn(`[SC] Playlist fetch failed: status=${response.status} url=${url}`);
                    this.lastPlaylistFailStatus = response.status;
                }
                return null;
            }

            if (this.playlistFailCount > 0) {
                logger.info(`[SC] Playlist fetch recovered after ${this.playlistFailCount} failures url=${url}`);
                this.playlistFailCount = 0;
                this.lastPlaylistFailStatus = 0;
            }

            const text = await response.text();
            const decrypted = decryptM3u8(text);
            if (!decrypted) {
                logger.warn(`[SC] Playlist decryption failed (mouflon keys missing or wrong): url=${url}`);
                return null;
            }
            return decrypted;
        } catch (error: any) {
            this.playlistFailCount++;
            if (this.playlistFailCount === 1) {
                logger.error(`[SC] Playlist fetch error: ${url}`, { error: error.message });
            }
            return null;
        }
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
            logger.warn(`[SC] Segment download failed: ${response.status}`, { tsUrl });
            return { data: null, retryable: false };
        } catch (error: any) {
            logger.warn(`[SC] Segment fetch error: ${error.message}`, { tsUrl });
            return { data: null, retryable: true };
        }
    }
}
