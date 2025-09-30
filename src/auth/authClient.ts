// src/auth/authClient.ts
import logger from '../logger.js';

const COOKIE_KEY = "cookie";

export interface RefreshResult {
    newTangoST: string | null;
    newTangoRT: string | null;
}

export interface TokenDataResult {
    tt: string | null;
    ttu: string | null;
    tte: string | null;
}

/**
 * Calls the session refresh endpoint.
 * @param username The username from the JWT.
 * @param tangoRT The current refresh token.
 * @returns An object containing the new ST and RT if successful.
 */
export async function refreshSession(username: string, tangoRT: string): Promise<RefreshResult | null> {
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

        const allCookies = response.headers.getSetCookie();
        let newTangoST: string | null = null;
        let newTangoRT: string | null = null;

        for (const cookieString of allCookies) {
            const trimmedCookie = cookieString.trim();
            if (trimmedCookie.startsWith("Tango-ST=")) {
                newTangoST = trimmedCookie.split(";")[0].substring("Tango-ST=".length);
            } else if (trimmedCookie.startsWith("Tango-RT=")) {
                newTangoRT = trimmedCookie.split(";")[0].substring("Tango-RT=".length);
            }
        }
        return { newTangoST, newTangoRT };

    } catch (error) {
        logger.error(`Network error during session refresh`, { error });
        return null;
    }
}

/**
 * Fetches the short-lived tokens (tt, ttu, tte).
 * @param tangoST The current session token.
 * @returns An object containing the tt, ttu, and tte cookies if successful.
 */
export async function fetchTokenData(tangoST: string): Promise<TokenDataResult | null> {
    try {
        const options: RequestInit = {
            method: "GET",
            headers: { [COOKIE_KEY]: `Tango-ST=${tangoST}` }
        };
        const response = await fetch("https://gateway.tango.me/proxycador/api/public/v1/live/stream/v1/tokenData", options);

        if (!response.ok) {
            logger.error(`Failed to fetch token data, status: ${response.status}`);
            return null;
        }
        
        const allCookies = response.headers.getSetCookie();
        let tt: string | null = null;
        let ttu: string | null = null;
        let tte: string | null = null;

        for (const cookieString of allCookies) {
            const trimmedCookie = cookieString.trim();
            if (trimmedCookie.startsWith("tt=")) tt = trimmedCookie.split("=")[1].split(";")[0];
            if (trimmedCookie.startsWith("ttu=")) ttu = trimmedCookie.split("=")[1].split(";")[0];
            if (trimmedCookie.startsWith("tte=")) tte = trimmedCookie.split("=")[1].split(";")[0];
        }
        return { tt, ttu, tte };

    } catch (error) {
        logger.error(`Network error during token data fetch`, { error });
        return null;
    }
}