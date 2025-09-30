// src/requests.ts
import logger from './logger.js';
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
    authContext: AuthContext,
    authType: 'st' | 'full', // 'none' is no longer used by any caller
    responseType: 'json' | 'text' | 'arrayBuffer' = 'json'
): Promise<ApiResponse<T>> {
    try {
        const headers: HeadersInit = {};
        if (authType === 'st') {
            headers[COOKIE_KEY] = authContext.createCookieST();
        } else if (authType === 'full') {
            headers[COOKIE_KEY] = authContext.createCookie();
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

export async function getFollowingResponseBody(authContext: AuthContext) {
    const response = await makeApiRequest<any>("https://gateway.tango.me/proxycador/api/public/v1/live/feeds/v1/following?pageCount=0&pageSize=100", "GET", authContext, 'st', 'json');
    return response.success ? response.data : null;
}

export async function getStreamerAlias(streamerId: string, authContext: AuthContext): Promise<string> {
    const response = await makeApiRequest<any>(`https://gateway.tango.me/proxycador/api/profiles/v2/single?id=${streamerId}&basicProfile=true&liveStats=true&followStats=true`, "GET", authContext, 'st', 'json');
    if (response.success && response.data?.basicProfile?.aliases?.[0]?.alias) {
        return response.data.basicProfile.aliases[0].alias;
    }
    return streamerId;
}

export async function getMasterList(masterListUrl: string, authContext: AuthContext) {
    const response = await makeApiRequest<string>(masterListUrl, "GET", authContext, 'full', 'text');
    return response.success ? response.data : null;
}

export function getLiveList(liveUrl: string, authContext: AuthContext): Promise<ApiResponse<string>> {
    return makeApiRequest<string>(liveUrl, "GET", authContext, 'full', 'text');
}

export async function getTsSegment(tsUrl: string): Promise<Buffer | null> {
    try {
        // This request is unauthenticated, so it doesn't need the helper
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