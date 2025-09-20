// src/requests.ts
import * as crypto from 'crypto';

import logger from './logger.js';
import * as utils from './utils.js';

const COOKIE_KEY = "cookie"; // lower case

/**
 * Represents the result of an API request, indicating success or failure
 * and containing the data or error information.
 */
export interface ApiResponse<T> {
    success: boolean;
    data: T | null;
    status?: number; // HTTP status code
    error?: Error;
}

/**
 * A centralized and robust wrapper for making API requests.
 * It handles header creation, fetching, response parsing, and returns a structured
 * response object indicating success or failure, including HTTP status on failure.
 * @param url The URL to fetch.
 * @param method The HTTP method (e.g., 'GET').
 * @param authType The type of authentication cookie to create.
 * @param responseType The expected type of the response body.
 * @returns An ApiResponse object with detailed success/fail information.
 */
async function makeApiRequest<T>(
    url: string,
    method: string,
    authType: 'st' | 'full' | 'none',
    responseType: 'json' | 'text' | 'arrayBuffer' = 'json'
): Promise<ApiResponse<T>> {
    try {
        // Step 1: Build the headers. This can throw if tokens are missing.
        const headers: HeadersInit = {};
        if (authType === 'st') {
            headers[COOKIE_KEY] = utils.createCookieST();
        } else if (authType === 'full') {
            headers[COOKIE_KEY] = utils.createCookie();
        }

        const options: RequestInit = { method, headers };

        // Step 2: Make the network request.
        const response = await fetch(url, options);

        if (!response.ok) {
            const error = new Error(`Request failed with status ${response.status} for URL: ${url}`);
            // --- CHANGE IS HERE ---
            // The generic logger.warn calls have been removed.
            // The calling function now has the responsibility to log with more context.
            return { success: false, data: null, status: response.status, error };
        }

        // Step 3: Parse the response based on the expected type.
        let body;
        switch (responseType) {
            case 'json':
                body = await response.json();
                break;
            case 'text':
                body = await response.text();
                break;
            case 'arrayBuffer':
                body = await response.arrayBuffer();
                break;
        }
        return { success: true, data: body as T, status: response.status };

    } catch (error) {
        // Step 4: Centralized error handling for token creation, network, or parsing errors.
        const e = error as Error;
        logger.warn(`API request to ${url} failed with network/parsing error.`, { error: e.message });
        // Status is undefined here because the error is not from an HTTP response.
        return { success: false, data: null, error: e };
    }
}


export async function getFollowingResponseBody() {
    // TODO non-LLM: test if pageSize bigger than 100 works
    // TODO LLM: if not, implement pagination
    const response = await makeApiRequest<any>("https://gateway.tango.me/proxycador/api/public/v1/live/feeds/v1/following?pageCount=0&pageSize=100", "GET", 'st', 'json');
    return response.success ? response.data : null;
}

export async function getStreamerAlias(streamerId: string): Promise<string> {
    const response = await makeApiRequest<any>(
        `https://gateway.tango.me/proxycador/api/profiles/v2/single?id=${streamerId}&basicProfile=true&liveStats=true&followStats=true`,
        "GET",
        'st',
        'json'
    );

    // Keep the logic to extract the alias here, but handle the null case from makeApiRequest
    if (response.success && response.data?.basicProfile?.aliases?.[0]?.alias) {
        return response.data.basicProfile.aliases[0].alias;
    }

    return streamerId; // Fallback to streamerId if API call failed or alias not found
}

export async function getMasterList(masterListUrl: string) {
    const response = await makeApiRequest<string>(masterListUrl, "GET", 'full', 'text');
    return response.success ? response.data : null;
}

export function getLiveList(liveUrl: string): Promise<ApiResponse<string>> {
    return makeApiRequest<string>(liveUrl, "GET", 'full', 'text');
}

/**
 * Fetches the token data required to get the `tt`, `ttu`, and `tte` cookies.
 * This request needs the Tango-ST.
 * Returns the raw `Response` object on success to allow header processing.
 */
export async function getTokenDataResponse(): Promise<Response | null> {
    try {
        const options: RequestInit = {
            method: "GET",
            headers: {
                [COOKIE_KEY]: utils.createCookieST(),
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

/**
 * Posts to the session refresh endpoint using the Tango-RT.
 * This returns a new Tango-ST and a new Tango-RT.
 * Returns the raw `Response` object on success to allow header processing.
 * @param username The username or sessionId from the Tango-RT JWT payload.
 */
export async function postRefreshSession(username: string): Promise<Response | null> {
    const refreshHeaders: HeadersInit = {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Referer': 'https://tango.me/',
        'content-type': 'application/json',
        'foreground-id': crypto.randomUUID(),
        'interaction-id': crypto.randomUUID(),
        'username': username,
        'x-app-client-session-id': crypto.randomUUID(),
        'Origin': 'https://tango.me',
        'DNT': '1',
        'Sec-GPC': '1',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
        'Connection': 'keep-alive',
        [COOKIE_KEY]: utils.createCookieRT(),
    };

    const refreshOptions = {
        method: "POST",
        headers: refreshHeaders,
    };

    try {
        const response = await fetch("https://gateway.tango.me/proxycador/api/session/refresh", refreshOptions);
        if (!response.ok) {
            const headersForLog = { ...refreshHeaders };
            delete headersForLog[COOKIE_KEY]; // Don't log the sensitive token
            logger.error(`Failed to refresh session. Tango-RT might be expired.`, {
                status: response.status,
                statusText: response.statusText,
                headers: headersForLog
            });
            return null;
        }
        return response;
    } catch (error) {
        logger.error(`Network error during session refresh`, { error });
        return null;
    }
}

// getTsSegment does not require authentication and has special error handling,
// so it's correct to keep it separate from the makeApiRequest pattern.
export async function getTsSegment(tsUrl: string): Promise<Buffer | null> {
    try {
        const tsResponse = await fetch(tsUrl);
        if (tsResponse.ok) {
            const tsBuffer = await tsResponse.arrayBuffer();
            return Buffer.from(tsBuffer);
        }
    } catch (error: any) {
        // This specific error is expected when a stream ends, so we don't log it as a critical failure.
        if (error?.message !== "terminated") {
            logger.error(`error-ts-segment, tsUrl: ${tsUrl}`, { error });
        }
    }
    return null;
}