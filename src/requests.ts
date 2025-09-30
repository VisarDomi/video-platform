// src/requests.ts
import logger from './logger.js';
import { AuthContext } from './auth/authContext.js';

/**
 * A generic, internal helper for making API requests.
 */
async function makeApiRequest<T>(
    url: string,
    method: string,
    headers: HeadersInit,
    responseType: 'json' | 'text' | 'arrayBuffer' = 'json'
): Promise<T | null> {
    try {
        const options: RequestInit = { method, headers };
        const response = await fetch(url, options);
        if (!response.ok) {
            logger.warn(`Request to ${url} failed with status ${response.status}`);
            return null;
        }
        switch (responseType) {
            case 'json': return await response.json();
            case 'text': return await response.text() as T;
            case 'arrayBuffer': return await response.arrayBuffer() as T;
        }
    } catch (error) {
        logger.warn(`API request to ${url} failed with network/parsing error.`, { error: (error as Error).message });
        return null;
    }
}

export async function getFollowingResponseBody(authContext: AuthContext): Promise<any | null> {
    const headers = authContext.getApiHeaders();
    return makeApiRequest<any>("https://gateway.tango.me/proxycador/api/public/v1/live/feeds/v1/following?pageCount=0&pageSize=100", "GET", headers, 'json');
}

export async function getStreamerAlias(streamerId: string, authContext: AuthContext): Promise<string> {
    const headers = authContext.getApiHeaders();
    const url = `https://gateway.tango.me/proxycador/api/profiles/v2/single?id=${streamerId}&basicProfile=true&liveStats=true&followStats=true`;
    const response = await makeApiRequest<any>(url, "GET", headers, 'json');
    if (response?.basicProfile?.aliases?.[0]?.alias) {
        return response.basicProfile.aliases[0].alias;
    }
    return streamerId;
}

export async function getMasterList(masterListUrl: string, authContext: AuthContext): Promise<string | null> {
    const headers = authContext.getStreamHeaders();
    return makeApiRequest<string>(masterListUrl, "GET", headers, 'text');
}

export async function getLiveList(liveUrl: string, authContext: AuthContext): Promise<{ success: boolean, data: string | null, status?: number }> {
    try {
        const headers = authContext.getStreamHeaders();
        const options: RequestInit = { method: "GET", headers };
        const response = await fetch(liveUrl, options);
        
        if (!response.ok) {
            return { success: false, data: null, status: response.status };
        }
        const data = await response.text();
        return { success: true, data, status: response.status };

    } catch (error) {
        logger.warn(`API request to ${liveUrl} failed with network/parsing error.`, { error: (error as Error).message });
        return { success: false, data: null };
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