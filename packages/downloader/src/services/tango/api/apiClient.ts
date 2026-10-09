import { promises as fs } from "fs";
import { readTokens } from "shared";
import type { Tokens } from "shared";
import logger from "../../../common/logger.js";
import { IDownloadSession, IStreamProvider, type SegmentValidationResult } from "../../core/interfaces.js";
import { probeSegmentDimensions } from "../../download/segmentDimensions.js";
import { CDN_FETCH_TIMEOUT_MS } from "../../../common/timing.js";
import { PlaylistNotFoundError } from "../../core/playlistNotFoundError.js";
import { requestSignal } from "../../core/downloadUtils.js";

export interface TangoLiveStream {
    accountId: string;
    streamId: string;
    masterPlaylistUrl: string;
    status: string;
    kind: string;
}

export interface RejectedStreamInfo {
    status: string;
    kind: string;
    isPublic: boolean;
}

export interface TangoAccountLookup {
    live: Map<string, TangoLiveStream>;
    rejected: Map<string, RejectedStreamInfo>;
}

function getStreamHeaders(tokens: Tokens): HeadersInit {
    if (!tokens.tt || !tokens.ttu || !tokens.tte) {
        throw new Error("Cannot create stream headers: tt, ttu, or tte are missing from tokens.");
    }
    return { cookie: `tt=${tokens.tt};ttu=${tokens.ttu};tte=${tokens.tte}` };
}

export class ApiClient implements IStreamProvider {
    public readonly providerName = "tango";
    public readonly refreshMasterDuringDownload = false;
    // Tango lists six one-second segments: a five-second pause after one failed
    // playlist fetch (an expired token, a network blip) loses media.
    public readonly playlistRetryMs = 1_000;
    private latestLiveStreams = new Map<string, TangoLiveStream>();

    public constructor(private readonly tokenReader: () => Promise<Tokens> = readTokens) {
        logger.debug("[Tango] ApiClient initialized.");
    }

    private _getApiHeaders(tokens: Tokens): HeadersInit {
        if (!tokens.st) {
            throw new Error("Cannot create API headers: Tango-ST is missing from tokens.");
        }
        return {
            cookie: `Tango-ST=${tokens.st}`,
            Accept: "application/json",
        };
    }

    private async _makeApiRequest<T>(
        url: string,
        method: string,
        headers: HeadersInit,
        responseType: "json" | "text" | "arrayBuffer" = "json",
        body: any = null,
        // Statuses the caller handles as an ordinary answer: a debug line only.
        expectedStatuses: readonly number[] = [],
    ): Promise<T | null> {
        try {
            const options: RequestInit = {
                method,
                headers,
                signal: AbortSignal.timeout(CDN_FETCH_TIMEOUT_MS),
            };
            if (body) {
                options.body = JSON.stringify(body);
                (headers as Record<string, string>)["Content-Type"] = "application/json";
            }

            const response = await fetch(url, options);
            if (!response.ok) {
                logger.log(expectedStatuses.includes(response.status) ? "debug" : "error", `[Tango] API request to ${url} failed`, {
                    status: response.status,
                    statusText: response.statusText,
                });
                return null;
            }
            switch (responseType) {
                case "json":
                    return await response.json();
                case "text":
                    return (await response.text()) as T;
                case "arrayBuffer":
                    return (await response.arrayBuffer()) as T;
            }
        } catch (error) {
            logger.error(`[Tango] API request to ${url} failed with network/parsing error.`, { errorMessage: (error as Error).message });
            return null;
        }
    }

    public async getLiveStreamsByAccountIds(accountIds: string[]): Promise<TangoAccountLookup | null> {
        if (accountIds.length === 0) {
            this.latestLiveStreams.clear();
            return { live: new Map(), rejected: new Map() };
        }

        try {
            const tokens = await this.tokenReader();
            const headers = this._getApiHeaders(tokens);
            const response = await this._makeApiRequest<any>(
                `https://gateway.tango.me/stream/social/v2/list/byEncryptedAccountIds?pageSize=${accountIds.length}`,
                "POST",
                headers,
                "json",
                {
                    moderationLevel: 5,
                    accountIds,
                    forceAllowPulsz: false,
                },
            );

            if (!response || !Array.isArray(response.records)) return null;

            const live = new Map<string, TangoLiveStream>();
            const rejected = new Map<string, RejectedStreamInfo>();
            const records = response.records;
            const requestedIds = new Set(accountIds);

            for (const record of records) {
                const stream = record?.stream;
                const accountId = stream?.encryptedAccountId;
                const masterPlaylistUrl = stream?.masterListUrl ?? record?.viewInfo?.hlsStreamInfo?.masterUrl;
                const status = stream?.status;
                const kind = stream?.streamKind;
                const isPublic = kind === "PUBLIC" || record?.isPublic === true;
                const isLiving = typeof status !== "string" || status === "LIVING";

                if (
                    typeof accountId !== "string" ||
                    !requestedIds.has(accountId) ||
                    typeof masterPlaylistUrl !== "string"
                ) {
                    continue;
                }

                if (!isLiving || !isPublic) {
                    rejected.set(accountId, {
                        status: typeof status === "string" ? status : "LIVING",
                        kind: typeof kind === "string" ? kind : "UNKNOWN",
                        isPublic: record?.isPublic ?? false,
                    });
                    continue;
                }

                live.set(accountId, {
                    accountId,
                    streamId: String(stream.id ?? record?.viewInfo?.streamId ?? ""),
                    masterPlaylistUrl,
                    status: typeof status === "string" ? status : "LIVING",
                    kind: typeof kind === "string" ? kind : "PUBLIC",
                });
            }

            this.latestLiveStreams = live;
            return { live, rejected };
        } catch (error) {
            logger.error(`[Tango] Unexpected error in getLiveStreamsByAccountIds`, { error: (error as Error).message });
            return null;
        }
    }


    public async getMasterList(masterListUrl: string): Promise<string | null> {
        try {
            const tokens = await this.tokenReader();
            const headers = getStreamHeaders(tokens);
            // A master that 404s just after a stream (re)starts is retried by the
            // session; one that keeps failing ends it with zero segments, a warning.
            return await this._makeApiRequest<string>(masterListUrl, "GET", headers, "text", null, [404]);
        } catch (error) {
            logger.error(`[Tango] Unexpected error in getMasterList for ${masterListUrl}`, { error: (error as Error).message });
            return null;
        }
    }

    public createDownloadSession(): IDownloadSession {
        return new TangoDownloadSession(this.tokenReader);
    }

    public async parseMasterPlaylist(masterUrl: string): Promise<string | null> {
        const masterListBody = await this.getMasterList(masterUrl);
        if (!masterListBody) return null;

        const lines = masterListBody.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const variants: { uri: string; pixels: number; bandwidth: number }[] = [];
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
            const uri = lines[i + 1];
            if (!uri || uri.startsWith("#")) continue;
            const resolution = lines[i].match(/RESOLUTION=(\d+)x(\d+)/);
            const bandwidth = lines[i].match(/(?:[:,])BANDWIDTH=(\d+)/);
            variants.push({
                uri,
                pixels: resolution ? Number(resolution[1]) * Number(resolution[2]) : 0,
                bandwidth: bandwidth ? Number(bandwidth[1]) : 0,
            });
        }
        variants.sort((a, b) => b.pixels - a.pixels || b.bandwidth - a.bandwidth);
        if (variants[0]) return new URL(variants[0].uri.replace(/&$/, ""), masterUrl).href;
        if (lines.some((line) => line.startsWith("#EXTINF:"))) return masterUrl;
        logger.warn(`[Tango] No playable variant in master playlist: ${masterUrl}`);
        return null;
    }

    public async validateSegment(filePath: string): Promise<SegmentValidationResult> {
        try {
            const stats = await fs.stat(filePath);
            if (stats.size <= 0) return { valid: false };
        } catch {
            return { valid: false };
        }

        const dimensions = await probeSegmentDimensions(filePath);
        if (!dimensions) {
            logger.warn(`[Tango] Unknown segment dimensions; retaining with an input boundary: ${filePath}`);
        }
        return { valid: true, dimensions };
    }

    public async recoverVariant(_masterPlaylistUrl: string): Promise<string | null> {
        return null;
    }

    public async shouldRetry(context: import("../../core/interfaces.js").DownloadExitContext): Promise<string | null> {
        if (context.exitReason === "aborted") return null;
        const stream = this.latestLiveStreams.get(context.streamerId);
        if (stream?.streamId === context.recordingId) {
            return stream.masterPlaylistUrl;
        }
        return context.lastMasterUrl;
    }
}

class TangoDownloadSession implements IDownloadSession {
    private static readonly FETCH_TIMEOUT_MS = CDN_FETCH_TIMEOUT_MS;
    // A 401 run is logged when it starts and when it ends, not on every retry.
    private unauthorizedCount = 0;
    constructor(private readonly tokenReader: () => Promise<Tokens>) {}

    public async fetchPlaylist(url: string, signal?: AbortSignal): Promise<string | null> {
        try {
            const tokens = await this.tokenReader();
            const headers = getStreamHeaders(tokens);
            const response = await fetch(url, {
                method: "GET",
                headers,
                signal: requestSignal(TangoDownloadSession.FETCH_TIMEOUT_MS, signal),
            });

            if (response.status === 404) throw new PlaylistNotFoundError(url);

            if (!response.ok) {
                if (response.status === 401 && tokens.tte) {
                    const ttlNow = parseInt(tokens.tte, 10) - Math.floor(Date.now() / 1000);
                    if (this.unauthorizedCount++ === 0) {
                        logger.error(`[Tango] Playlist 401 — ttlAtUse=${tokens.ttlAtReadSec}s ttlNow=${ttlNow}s tokenAge=${tokens.tokenAgeMs}ms url=${url}`);
                    }
                } else {
                    logger.debug(`[Tango] Playlist fetch failed: status=${response.status} url=${url}`);
                }
                return null;
            }
            if (this.unauthorizedCount > 0) {
                logger.info(`[Tango] Playlist authorized again after ${this.unauthorizedCount} 401 response(s) url=${url}`);
                this.unauthorizedCount = 0;
            }
            return await response.text();
        } catch (error) {
            if (error instanceof PlaylistNotFoundError) throw error;
            if (!signal?.aborted) logger.debug(`[Tango] Playlist fetch error: ${url}`, { error: (error as Error).message });
            return null;
        }
    }

    public async fetchSegment(tsUrl: string): Promise<import("../../core/interfaces.js").SegmentFetchResult> {
        try {
            const tsResponse = await fetch(tsUrl, {
                signal: AbortSignal.timeout(TangoDownloadSession.FETCH_TIMEOUT_MS),
            });
            if (tsResponse.ok) {
                const tsBuffer = await tsResponse.arrayBuffer();
                return { data: Buffer.from(tsBuffer) };
            }
            logger.debug(`[Tango] Segment download failed: status=${tsResponse.status}`, { tsUrl });
            // 429 asks to retry later; any other HTTP error ends the attempt.
            return { data: null, retryable: tsResponse.status === 429, status: tsResponse.status };
        } catch (error: any) {
            logger.debug(`[Tango] Segment fetch error: ${error.message}`, { tsUrl });
            return { data: null, retryable: true };
        }
    }
}
