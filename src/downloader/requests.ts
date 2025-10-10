// src/downloader/requests.ts
import logger from "../common/logger.js";
import * as constants from "../common/constants.js";

export interface Tokens {
    st: string | null;
    tt: string | null;
    ttu: string | null;
    tte: string | null;
}

function getApiHeaders(tokens: Tokens): HeadersInit {
    if (!tokens.st) {
        throw new Error("Cannot create API headers: Tango-ST is missing from tokens.");
    }
    return {
        [constants.HEADERS.COOKIE]: `${constants.COOKIE_NAMES.TANGO_ST_PREFIX}${tokens.st}`,
        Accept: "application/json",
    };
}

function getStreamHeaders(tokens: Tokens): HeadersInit {
    if (!tokens.tt || !tokens.ttu || !tokens.tte) {
        throw new Error("Cannot create stream headers: tt, ttu, or tte are missing from tokens.");
    }
    const cookie = `tt=${tokens.tt};ttu=${tokens.ttu};tte=${tokens.tte}`;
    return { [constants.HEADERS.COOKIE]: cookie };
}

/**
 * A generic, internal helper for making API requests. Now supports request body.
 */
async function makeApiRequest<T>(
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
            // Add content-type header for POST requests with a JSON body
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

export async function getFollowingResponseBody(tokens: Tokens): Promise<any | null> {
    const headers = getApiHeaders(tokens);
    return makeApiRequest<any>("https://gateway.tango.me/proxycador/api/public/v1/live/feeds/v1/following?pageCount=0&pageSize=200", "GET", headers, "json");
}

export async function getAllFollowing(tokens: Tokens): Promise<any | null> {
    const headers = getApiHeaders(tokens);
    const url = `https://gateway.tango.me/discovery/v3/followings/me/list?size=500`;
    return makeApiRequest<any>(url, "GET", headers, "json");
}

export async function getAliasesInBatch(streamerIds: string[], tokens: Tokens): Promise<any | null> {
    const headers = getApiHeaders(tokens);
    const url = `https://gateway.tango.me/proxycador/api/public/v1/profiles/v2/batch?basicProfile=true&liveStats=false&followStats=false`;
    return makeApiRequest<any>(url, "POST", headers, "json", streamerIds);
}

export async function getStreamerAlias(streamerId: string, tokens: Tokens): Promise<string> {
    const headers = getApiHeaders(tokens);
    const url = `https://gateway.tango.me/proxycador/api/profiles/v2/single?id=${streamerId}&basicProfile=true&liveStats=false&followStats=false`;
    const response = await makeApiRequest<any>(url, "GET", headers, "json");
    if (response?.basicProfile?.aliases?.[0]?.alias) {
        return response.basicProfile.aliases[0].alias;
    }
    return streamerId;
}

export async function getMasterList(masterListUrl: string, tokens: Tokens): Promise<string | null> {
    const headers = getStreamHeaders(tokens);
    return makeApiRequest<string>(masterListUrl, "GET", headers, "text");
}

export async function getLiveList(liveUrl: string, tokens: Tokens): Promise<{ success: boolean; data: string | null; status?: number }> {
    try {
        const headers = getStreamHeaders(tokens);
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
