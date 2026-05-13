import * as path from "path";
import { readTokens } from "shared";
import type { Tokens } from "shared";
import logger from "../../../common/logger.js";
import { IDownloadSession, IStreamProvider } from "../../core/interfaces.js";
import { MediaValidator } from "../../../common/mediaValidator.js";
import { CDN_FETCH_TIMEOUT_MS } from "../../../common/timing.js";

export interface TangoLiveStream {
    accountId: string;
    streamId: string;
    masterPlaylistUrl: string;
    status: string;
    kind: string;
}

function getStreamHeaders(tokens: Tokens): HeadersInit {
    if (!tokens.tt || !tokens.ttu || !tokens.tte) {
        throw new Error("Cannot create stream headers: tt, ttu, or tte are missing from tokens.");
    }
    return { cookie: `tt=${tokens.tt};ttu=${tokens.ttu};tte=${tokens.tte}` };
}

export class ApiClient implements IStreamProvider {
    public readonly providerName = "tango";

    public constructor() {
        logger.info("[Tango] ApiClient initialized.");
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
        body: any = null
    ): Promise<T | null> {
        try {
            const options: RequestInit = { method, headers };
            if (body) {
                options.body = JSON.stringify(body);
                (headers as Record<string, string>)["Content-Type"] = "application/json";
            }

            const response = await fetch(url, options);
            if (!response.ok) {
                logger.error(`[Tango] API request to ${url} failed`, {
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

    public async getFollowingResponseBody(): Promise<any | null> {
        try {
            const tokens = await readTokens();
            const headers = this._getApiHeaders(tokens);
            return this._makeApiRequest<any>(
                "https://gateway.tango.me/proxycador/api/public/v1/live/feeds/v1/following?pageCount=0&pageSize=200",
                "GET",
                headers,
                "json"
            );
        } catch (error) {
            logger.error(`[Tango] Unexpected error in getFollowingResponseBody`, { error: (error as Error).message });
            return null;
        }
    }

    public async getLiveStreamsByAccountIds(accountIds: string[]): Promise<Map<string, TangoLiveStream> | null> {
        if (accountIds.length === 0) {
            return new Map();
        }

        try {
            const tokens = await readTokens();
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

            if (!response) return null;

            const liveStreams = new Map<string, TangoLiveStream>();
            const records = Array.isArray(response.records) ? response.records : [];

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
                    typeof masterPlaylistUrl !== "string"
                ) {
                    continue;
                }

                if (!isLiving || !isPublic) {
                    logger.info(`[Tango] Account stream rejected`, {
                        accountId,
                        status,
                        kind,
                        isPublic: record?.isPublic,
                    });
                    continue;
                }

                liveStreams.set(accountId, {
                    accountId,
                    streamId: stream.id ?? record?.viewInfo?.streamId ?? "",
                    masterPlaylistUrl,
                    status: typeof status === "string" ? status : "LIVING",
                    kind: typeof kind === "string" ? kind : "PUBLIC",
                });
            }

            logger.info(
                `[Tango] Account stream lookup: requested=${accountIds.length} returned=${records.length} livePublic=${liveStreams.size}`,
            );
            return liveStreams;
        } catch (error) {
            logger.error(`[Tango] Unexpected error in getLiveStreamsByAccountIds`, { error: (error as Error).message });
            return null;
        }
    }


    public async getMasterList(masterListUrl: string): Promise<string | null> {
        try {
            const tokens = await readTokens();
            const headers = getStreamHeaders(tokens);
            return this._makeApiRequest<string>(masterListUrl, "GET", headers, "text");
        } catch (error) {
            logger.error(`[Tango] Unexpected error in getMasterList for ${masterListUrl}`, { error: (error as Error).message });
            return null;
        }
    }

    public createDownloadSession(): IDownloadSession {
        return new TangoDownloadSession();
    }

    public async parseMasterPlaylist(masterUrl: string): Promise<string | null> {
        const masterListBody = await this.getMasterList(masterUrl);
        if (!masterListBody) return null;

        const masterLines = masterListBody.split("\n").filter((line) => line.trim() !== "");
        let relativeLiveUrl: string | undefined;

        for (let i = 0; i < masterLines.length; i++) {
            if (masterLines[i].includes("RESOLUTION=1280x720")) {
                relativeLiveUrl = masterLines[i + 1];
                break;
            }
        }

        if (!relativeLiveUrl) {
            logger.warn(`[Tango] Could not find HD stream in master playlist: ${masterUrl}`);
            return null;
        }

        const cinemaApiUrl = masterUrl.split("/v2/")[0];
        let livePlaylistUrl = `${cinemaApiUrl}${relativeLiveUrl}`;
        if (livePlaylistUrl.endsWith("&")) {
            livePlaylistUrl = livePlaylistUrl.substring(0, livePlaylistUrl.length - 1);
        }
        return livePlaylistUrl;
    }

    public async validateSegment(filePath: string): Promise<{ valid: boolean; duration?: number }> {
        const info = await MediaValidator.getMediaInfo(filePath);
        if (!info) return { valid: false };

        if (isNaN(info.bitRate) || info.bitRate < 1000) return { valid: false };

        if (!isNaN(info.duration) && info.duration > 3600) return { valid: false };

        if (info.width === 360 && info.height === 640) return { valid: false };

        if (info.videoDuration <= 0 && info.audioDuration <= 0 && info.formatDuration > 0) {
            logger.warn(`[Tango] validateSegment: using format duration fallback for ${path.basename(filePath)}`);
        } else if (info.videoDuration > 0 && info.formatDuration > 0 && Math.abs(info.formatDuration - info.videoDuration) > 0.01) {
            logger.debug(`[Tango] validateSegment: media duration differs from format duration for ${path.basename(filePath)}`, {
                videoDuration: info.videoDuration,
                audioDuration: info.audioDuration,
                formatDuration: info.formatDuration,
                selectedDuration: info.duration,
            });
        }

        return { valid: true, duration: info.duration };
    }

    public async recoverVariant(_masterPlaylistUrl: string): Promise<string | null> {
        return null;
    }

    public async shouldRetry(context: import("../../core/interfaces.js").DownloadExitContext): Promise<string | null> {
        if (context.exitReason === "aborted") return null;

        if (context.exitReason === "fetch-failed") {
            return context.lastMasterUrl;
        }

        const liveStreams = await this.getLiveStreamsByAccountIds([context.streamerId]);
        if (!liveStreams) {
            logger.info(`[Tango] ${context.streamerId}: shouldRetry=no (stream lookup failed after ${context.exitReason})`);
            return null;
        }

        const stream = liveStreams.get(context.streamerId);
        if (stream) {
            return stream.masterPlaylistUrl;
        }
        logger.info(`[Tango] ${context.streamerId}: shouldRetry=no (not live/public in account lookup after ${context.exitReason})`);
        return null;
    }
}

class TangoDownloadSession implements IDownloadSession {
    private static readonly FETCH_TIMEOUT_MS = CDN_FETCH_TIMEOUT_MS;

    public async fetchPlaylist(url: string): Promise<string | null> {
        try {
            const tokens = await readTokens();
            const headers = getStreamHeaders(tokens);
            const response = await fetch(url, {
                method: "GET",
                headers,
                signal: AbortSignal.timeout(TangoDownloadSession.FETCH_TIMEOUT_MS),
            });

            if (!response.ok) {
                if (response.status === 401 && tokens.tte) {
                    const ttlNow = parseInt(tokens.tte, 10) - Math.floor(Date.now() / 1000);
                    logger.error(`[Tango] Playlist 401 — ttlAtUse=${tokens.ttlAtReadSec}s ttlNow=${ttlNow}s tokenAge=${tokens.tokenAgeMs}ms url=${url}`);
                } else {
                    logger.warn(`[Tango] Playlist fetch failed: status=${response.status} url=${url}`);
                }
                return null;
            }
            return await response.text();
        } catch (error) {
            logger.warn(`[Tango] Playlist fetch error: ${url}`, { error: (error as Error).message });
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
            logger.warn(`[Tango] Segment download failed: status=${tsResponse.status}`, { tsUrl });
            return { data: null, retryable: false };
        } catch (error: any) {
            logger.warn(`[Tango] Segment fetch error: ${error.message}`, { tsUrl });
            return { data: null, retryable: true };
        }
    }
}
