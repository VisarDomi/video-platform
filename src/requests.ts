// src/requests.ts
import * as crypto from 'crypto';
import logger from './logger.js';
import * as utils from './utils.js';
import { AuthContext } from './authContext.js';

const COOKIE_KEY = "cookie";

export interface ApiResponse<T> {
    success: boolean;
    data: T | null;
    status?: number;
    error?: Error;
}

async function makeApiRequest<T>(
    url: string,
    method: string,
    authType: 'st' | 'full' | 'none',
    responseType: 'json' | 'text' | 'arrayBuffer' = 'json'
): Promise<ApiResponse<T>> {
    try {
        const headers: HeadersInit = {};
        if (authType === 'st') {
            headers[COOKIE_KEY] = utils.createCookieST();
        } else if (authType === 'full') {
            headers[COOKIE_KEY] = utils.createCookie();
        }
        const options: RequestInit = { method, headers };
        const response = await fetch(url, options);
        if (!response.ok) {
            const error = new Error(`Request failed with status ${response.status} for URL: ${url}`);
            return { success: false, data: null, status: response.status, error };
        }
        let body;
        switch (responseType) {
            case 'json': body = await response.json(); break;
            case 'text': body = await response.text(); break;
            case 'arrayBuffer': body = await response.arrayBuffer(); break;
        }
        return { success: true, data: body as T, status: response.status };
    } catch (error) {
        const e = error as Error;
        logger.warn(`API request to ${url} failed with network/parsing error.`, { error: e.message });
        return { success: false, data: null, error: e };
    }
}

export async function getFollowingResponseBody() {
    const response = await makeApiRequest<any>("https://gateway.tango.me/proxycador/api/public/v1/live/feeds/v1/following?pageCount=0&pageSize=100", "GET", 'st', 'json');
    return response.success ? response.data : null;
}

export async function getStreamerAlias(streamerId: string): Promise<string> {
    const response = await makeApiRequest<any>(`https://gateway.tango.me/proxycador/api/profiles/v2/single?id=${streamerId}&basicProfile=true&liveStats=true&followStats=true`, "GET", 'st', 'json');
    if (response.success && response.data?.basicProfile?.aliases?.[0]?.alias) {
        return response.data.basicProfile.aliases[0].alias;
    }
    return streamerId;
}

export async function getMasterList(masterListUrl: string) {
    const response = await makeApiRequest<string>(masterListUrl, "GET", 'full', 'text');
    return response.success ? response.data : null;
}

export function getLiveList(liveUrl: string): Promise<ApiResponse<string>> {
    return makeApiRequest<string>(liveUrl, "GET", 'full', 'text');
}

export async function getTokenDataResponse(authContext: AuthContext): Promise<Response | null> {
    try {
        const tangoST = authContext.getTangoST();
        if (!tangoST) {
            throw new Error("Tango-ST not found in auth context");
        }
        const options: RequestInit = {
            method: "GET",
            headers: {
                [COOKIE_KEY]: `Tango-ST=${tangoST}`,
            }
        };
        const response = await fetch("https://gateway.tango.me/proxycador/api/public/v1/live/stream/v1/tokenData", options);
        if (!response.ok) {
            logger.error(`Failed to fetch token data, status: ${response.status}`);
            return null;
        }
        return response;
    } catch (error) {
        logger.error(`Network error during token data fetch`, { error });
        return null;
    }
}

export async function postRefreshSession(username: string, tangoRT: string): Promise<Response | null> {
    const refreshHeaders: HeadersInit = {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
        'Accept': 'application/json',
        'content-type': 'application/json',
        'username': username,
        'Origin': 'https://tango.me',
        [COOKIE_KEY]: `Tango-RT=${tangoRT}`,
    };
    const refreshOptions = { method: "POST", headers: refreshHeaders };
    try {
        const response = await fetch("https://gateway.tango.me/proxycador/api/session/refresh", refreshOptions);
        if (!response.ok) {
            logger.error(`Failed to refresh session. Tango-RT might be expired.`, { status: response.status });
            return null;
        }
        return response;
    } catch (error) {
        logger.error(`Network error during session refresh`, { error });
        return null;
    }
}

export async function getTsSegment(tsUrl: string): Promise<Buffer | null> {
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