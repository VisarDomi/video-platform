import * as path from "path";
import * as config from "../../../common/config.js";
import { FileSystemManager } from "../../../common/fileSystemManager.js";
import logger from "../../../common/logger.js";
import * as constants from "../../../common/constants.js";
import { IStreamProvider } from "../../core/interfaces.js";
import { TokenManager, Tokens } from "./tokenManager.js";
import { MediaValidator } from "../../../common/mediaValidator.js";

export class ApiClient implements IStreamProvider {
    private tokenManager: TokenManager;

    public constructor(tokenManager: TokenManager) {
        this.tokenManager = tokenManager;
        logger.info("[Tango] ApiClient initialized.");
    }

    private _getApiHeaders(tokens: Tokens): HeadersInit {
        if (!tokens.st) {
            throw new Error("Cannot create API headers: Tango-ST is missing from tokens.");
        }
        return {
            [constants.HEADERS.COOKIE]: `${constants.COOKIE_NAMES.TANGO_ST_PREFIX}${tokens.st}`,
            Accept: "application/json",
        };
    }

    private _getStreamHeaders(tokens: Tokens): HeadersInit {
        if (!tokens.tt || !tokens.ttu || !tokens.tte) {
            throw new Error("Cannot create stream headers: tt, ttu, or tte are missing from tokens.");
        }
        const cookie = `tt=${tokens.tt};ttu=${tokens.ttu};tte=${tokens.tte}`;
        return { [constants.HEADERS.COOKIE]: cookie };
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
            const tokens = await this.tokenManager.getTokens();
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

    public async getAllFollowing(): Promise<any | null> {
        try {
            const tokens = await this.tokenManager.getTokens();
            const headers = this._getApiHeaders(tokens);
            const url = `https://gateway.tango.me/discovery/v3/followings/me/list?size=500`;
            return this._makeApiRequest<any>(url, "GET", headers, "json");
        } catch (error) {
            logger.error(`[Tango] Unexpected error in getAllFollowing`, { error: (error as Error).message });
            return null;
        }
    }

    public async getAliasesInBatch(streamerIds: string[]): Promise<any | null> {
        try {
            const tokens = await this.tokenManager.getTokens();
            const headers = this._getApiHeaders(tokens);
            const url = `https://gateway.tango.me/proxycador/api/public/v1/profiles/v2/batch?basicProfile=true&liveStats=false&followStats=false`;
            return this._makeApiRequest<any>(url, "POST", headers, "json", streamerIds);
        } catch (error) {
            logger.error(`[Tango] Unexpected error in getAliasesInBatch`, { error: (error as Error).message });
            return null;
        }
    }

    public async getStreamerAlias(streamerId: string): Promise<string> {
        try {
            const tokens = await this.tokenManager.getTokens();
            const headers = this._getApiHeaders(tokens);
            const url = `https://gateway.tango.me/proxycador/api/profiles/v2/single?id=${streamerId}&basicProfile=true&liveStats=false&followStats=false`;
            const response = await this._makeApiRequest<any>(url, "GET", headers, "json");
            if (response?.basicProfile?.aliases?.[0]?.alias) {
                return response.basicProfile.aliases[0].alias;
            }
            return streamerId;
        } catch (error) {
            logger.error(`[Tango] Unexpected error in getStreamerAlias for ${streamerId}`, { error: (error as Error).message });
            return streamerId;
        }
    }

    // --- IStreamProvider Implementation ---

    public async getMasterList(masterListUrl: string): Promise<string | null> {
        try {
            const tokens = await this.tokenManager.getTokens();
            const headers = this._getStreamHeaders(tokens);
            return this._makeApiRequest<string>(masterListUrl, "GET", headers, "text");
        } catch (error) {
            logger.error(`[Tango] Unexpected error in getMasterList for ${masterListUrl}`, { error: (error as Error).message });
            return null;
        }
    }

    public async getLiveList(liveUrl: string): Promise<{ success: boolean; data: string | null }> {
        try {
            const tokens = await this.tokenManager.getTokens();
            const headers = this._getStreamHeaders(tokens);
            const options: RequestInit = { method: "GET", headers };
            const response = await fetch(liveUrl, options);

            if (!response.ok) {
                return { success: false, data: null };
            }
            const data = await response.text();
            return { success: true, data };
        } catch (error) {
            logger.warn(`[Tango] API request to ${liveUrl} failed with network/parsing error.`, { error: (error as Error).message });
            return { success: false, data: null };
        }
    }

    public async getTsSegment(tsUrl: string): Promise<Buffer | null> {
        try {
            const tsResponse = await fetch(tsUrl);
            if (tsResponse.ok) {
                const tsBuffer = await tsResponse.arrayBuffer();
                return Buffer.from(tsBuffer);
            } else {
                logger.warn(`[Tango] Failed to download TS segment, status: ${tsResponse.status}`, { tsUrl });
            }
        } catch (error: any) {
            if (error?.message !== "terminated") {
                logger.warn(`[Tango] Network error downloading TS segment: ${error.message}`, { tsUrl });
            }
        }
        return null;
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

    public async pollCurrentVariant(masterUrl: string, currentLiveUrl: string): Promise<string | null> {
        // Tango currently does not support dynamic quality switching in this downloader context
        return null;
    }

    public getSegmentUrl(baseUrl: string, segmentLine: string): string {
        if (segmentLine.startsWith("/")) {
            const urlObj = new URL(baseUrl);
            return `${urlObj.origin}${segmentLine}`;
        }
        return segmentLine;
    }

    public async setupDownloadDir(alias: string, date: Date): Promise<string | null> {
        const generateDownloadBaseName = (alias: string, date: Date): string => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, "0");
            const day = String(date.getDate()).padStart(2, "0");
            const hours = String(date.getHours()).padStart(2, "0");
            const minutes = String(date.getMinutes()).padStart(2, "0");
            const seconds = String(date.getSeconds()).padStart(2, "0");
            return `${year}-${month}-${day} ${hours}${minutes}${seconds} ${alias}`;
        };

        const baseFilename = generateDownloadBaseName(alias, date);
        const storageLocation = path.join(config.getConfig().storagePath, "tango", "downloader");

        const storageLocationExists = await FileSystemManager.ensureDirExists(storageLocation);
        if (!storageLocationExists) {
            logger.error(`[Tango] Could not create or access storage folder at: ${storageLocation}`);
            return null;
        }

        const segmentsDirPath = path.resolve(storageLocation, baseFilename);
        const segmentsDirExists = await FileSystemManager.ensureDirExists(segmentsDirPath);
        return segmentsDirExists ? segmentsDirPath : null;
    }

    public async validateSegment(filePath: string): Promise<boolean> {
        const info = await MediaValidator.getMediaInfo(filePath);
        if (!info) return false;

        // Condition 1: Bitrate < 1000 or NaN
        if (isNaN(info.bitRate) || info.bitRate < 1000) return false;

        // Condition 2: Insane Duration (> 1 hour)
        if (!isNaN(info.duration) && info.duration > 3600) return false;

        // Condition 3: Specific Tango corrupt resolution
        if (info.width === 360 && info.height === 640) return false;

        return true;
    }
}