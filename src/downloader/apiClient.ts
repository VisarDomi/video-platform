// src/downloader/apiClient.ts
import * as timersPromises from "timers/promises";
import * as path from "path";

import * as config from "../common/config.js";
import logger from "../common/logger.js";
import * as constants from "../common/constants.js";
import { Tokens } from "../common/interfaces.js";
import { FileSystemManager } from "../common/fileSystemManager.js";

export class ApiClient {
    private tokens: Tokens | null = null;

    private constructor() {
        logger.info("ApiClient initialized.");
    }

    public static async create(): Promise<ApiClient> {
        const instance = new ApiClient();
        await instance._loadTokens();
        return instance;
    }

    public startTokenWatcher(): void {
        const watch = async () => {
            const refreshInterval = config.getConfig().intervals.shortTokenRefresh;
            await timersPromises.setTimeout(refreshInterval);
            while (true) {
                await this._loadTokens();
                await timersPromises.setTimeout(refreshInterval);
            }
        };
        watch(); // Fire-and-forget
    }

    private async _loadTokens(): Promise<boolean> {
        const cfg = config.getConfig();
        const sessionFilePath = path.resolve(cfg.sharedStatePath, "session.json");
        const session = await FileSystemManager.readJsonFile<any>(sessionFilePath);

        if (!session) {
            if (this.tokens) {
                logger.warn("Tokens became invalid: session.json not found or is invalid.");
            }
            this.tokens = null;
            return false;
        }

        if (session.tangoST && session.tt && session.ttu && session.tte) {
            this.tokens = {
                st: session.tangoST,
                tt: session.tt,
                ttu: session.ttu,
                tte: session.tte,
            };
            return true;
        } else {
            logger.warn("Token load failed: session.json is missing required tokens.");
            this.tokens = null;
            return false;
        }
    }

    private async _getTokensForRequest(): Promise<Tokens> {
        while (!this.tokens) {
            logger.warn("Tokens not available. Waiting for session.json to be populated...");
            const loaded = await this._loadTokens();
            if (!loaded) {
                await timersPromises.setTimeout(5000); // wait 5s before retrying
            }
        }
        return this.tokens;
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
                logger.error(`API request to ${url} failed`, {
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
            logger.error(`API request to ${url} failed with network/parsing error.`, { errorMessage: (error as Error).message });
            return null;
        }
    }

    public async getFollowingResponseBody(): Promise<any | null> {
        const tokens = await this._getTokensForRequest();
        const headers = this._getApiHeaders(tokens);
        return this._makeApiRequest<any>(
            "https://gateway.tango.me/proxycador/api/public/v1/live/feeds/v1/following?pageCount=0&pageSize=200",
            "GET",
            headers,
            "json"
        );
    }

    public async getAllFollowing(): Promise<any | null> {
        const tokens = await this._getTokensForRequest();
        const headers = this._getApiHeaders(tokens);
        const url = `https://gateway.tango.me/discovery/v3/followings/me/list?size=500`;
        return this._makeApiRequest<any>(url, "GET", headers, "json");
    }

    public async getAliasesInBatch(streamerIds: string[]): Promise<any | null> {
        const tokens = await this._getTokensForRequest();
        const headers = this._getApiHeaders(tokens);
        const url = `https://gateway.tango.me/proxycador/api/public/v1/profiles/v2/batch?basicProfile=true&liveStats=false&followStats=false`;
        return this._makeApiRequest<any>(url, "POST", headers, "json", streamerIds);
    }

    public async getStreamerAlias(streamerId: string): Promise<string> {
        const tokens = await this._getTokensForRequest();
        const headers = this._getApiHeaders(tokens);
        const url = `https://gateway.tango.me/proxycador/api/profiles/v2/single?id=${streamerId}&basicProfile=true&liveStats=false&followStats=false`;
        const response = await this._makeApiRequest<any>(url, "GET", headers, "json");
        if (response?.basicProfile?.aliases?.[0]?.alias) {
            return response.basicProfile.aliases[0].alias;
        }
        return streamerId;
    }

    public async getMasterList(masterListUrl: string): Promise<string | null> {
        const tokens = await this._getTokensForRequest();
        const headers = this._getStreamHeaders(tokens);
        return this._makeApiRequest<string>(masterListUrl, "GET", headers, "text");
    }

    public async getLiveList(liveUrl: string): Promise<{ success: boolean; data: string | null }> {
        const tokens = await this._getTokensForRequest();

        try {
            const headers = this._getStreamHeaders(tokens);
            const options: RequestInit = { method: "GET", headers };
            const response = await fetch(liveUrl, options);

            if (!response.ok) {
                return { success: false, data: null };
            }
            const data = await response.text();
            return { success: true, data };
        } catch (error) {
            logger.warn(`API request to ${liveUrl} failed with network/parsing error.`, { error: (error as Error).message });
            return { success: false, data: null };
        }
    }

    public async getTsSegment(tsUrl: string): Promise<Buffer | null> {
        try {
            const tsResponse = await fetch(tsUrl);
            if (tsResponse.ok) {
                const tsBuffer = await tsResponse.arrayBuffer();
                return Buffer.from(tsBuffer);
            }
        } catch (error: any) {
            if (error?.message !== "terminated") {
                logger.error(`error-ts-segment, tsUrl: ${tsUrl}`, { error });
            }
        }
        return null;
    }
}
