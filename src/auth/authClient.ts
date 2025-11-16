import * as constants from "../common/constants.js";

import * as authQueue from "./authQueue.js";

export interface RefreshResult {
    newTangoST: string;
    newTangoRT: string | null;
}

export interface TokenDataResult {
    tt: string;
    ttu: string;
    tte: string;
}

/**
 * Calls the session refresh endpoint.
 * @throws Will throw an error if the request fails or the response is invalid.
 */
export async function refreshSession(username: string, tangoRT: string): Promise<RefreshResult> {
    const refreshHeaders: HeadersInit = {
        "User-Agent": constants.HEADERS.USER_AGENT,
        Accept: "application/json",
        "content-type": "application/json",
        username: username,
        Origin: constants.TANGO_URLS.HOME,
        [constants.HEADERS.COOKIE]: `${constants.COOKIE_NAMES.TANGO_RT_PREFIX}${tangoRT}`,
    };
    const refreshOptions = { method: "POST", headers: refreshHeaders };

    const response = await authQueue.requestQueue.add<Response>(constants.TANGO_URLS.SESSION_REFRESH, refreshOptions);
    if (!response.ok) {
        throw new Error(`Session refresh failed with status ${response.status}. Tango-RT may be expired.`);
    }

    const allCookies = response.headers.getSetCookie();
    let newTangoST: string | null = null;
    let newTangoRT: string | null = null;

    for (const cookieString of allCookies) {
        const trimmedCookie = cookieString.trim();
        if (trimmedCookie.startsWith(constants.COOKIE_NAMES.TANGO_ST_PREFIX)) {
            newTangoST = trimmedCookie.split(";")[0].substring(constants.COOKIE_NAMES.TANGO_ST_PREFIX.length);
        } else if (trimmedCookie.startsWith(constants.COOKIE_NAMES.TANGO_RT_PREFIX)) {
            newTangoRT = trimmedCookie.split(";")[0].substring(constants.COOKIE_NAMES.TANGO_RT_PREFIX.length);
        }
    }

    if (!newTangoST) {
        throw new Error("Refresh endpoint did not return a new Tango-ST cookie.");
    }

    return { newTangoST, newTangoRT };
}

/**
 * Fetches the short-lived tokens (tt, ttu, tte).
 * @throws Will throw an error if the request fails or the response is invalid.
 */
export async function fetchTokenData(tangoST: string): Promise<TokenDataResult> {
    const options: RequestInit = {
        method: "GET",
        headers: { [constants.HEADERS.COOKIE]: `${constants.COOKIE_NAMES.TANGO_ST_PREFIX}${tangoST}` },
    };
    const response = await authQueue.requestQueue.add<Response>(constants.TANGO_URLS.TOKEN_DATA, options);

    if (!response.ok) {
        throw new Error(`Token data fetch failed with status ${response.status}`);
    }

    const allCookies = response.headers.getSetCookie();
    let tt: string | null = null;
    let ttu: string | null = null;
    let tte: string | null = null;

    for (const cookieString of allCookies) {
        const trimmedCookie = cookieString.trim();
        if (trimmedCookie.startsWith(constants.COOKIE_NAMES.TT_PREFIX)) tt = trimmedCookie.split("=")[1].split(";")[0];
        if (trimmedCookie.startsWith(constants.COOKIE_NAMES.TTU_PREFIX)) ttu = trimmedCookie.split("=")[1].split(";")[0];
        if (trimmedCookie.startsWith(constants.COOKIE_NAMES.TTE_PREFIX)) tte = trimmedCookie.split("=")[1].split(";")[0];
    }

    if (!tt || !ttu || !tte) {
        throw new Error("Token data response was missing one or more required cookies (tt, ttu, tte).");
    }

    return { tt, ttu, tte };
}
