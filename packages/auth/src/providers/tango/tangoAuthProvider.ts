import logger from "../../common/logger.js";
import { requestQueue } from "../../auth/authQueue.js";
import * as authUtils from "../../auth/authUtils.js";
import { Account, IAuthProvider, TokenBag, RefreshResult, ShortTokenResult } from "../interfaces.js";
import * as constants from "./constants.js";
import { extractTokens } from "./tangoLogin.js";

export class TangoAuthProvider implements IAuthProvider {
    readonly name = "tango";

    readonly intervals = {
        shortTokenRefresh: 5000,
        sessionRefresh: 30 * 60 * 1000,
    };

    async login(account: Account): Promise<TokenBag> {
        const result = await extractTokens(account);
        if (!result) {
            throw new Error(`Browser login failed for ${account.email}`);
        }
        return result;
    }

    async refreshSession(tokenBag: TokenBag): Promise<RefreshResult> {
        const payload = authUtils.parseJwtPayload(tokenBag.refreshToken);
        const username = payload?.username || payload?.sessionId;
        if (!username) {
            throw new Error("Could not extract username from refresh token.");
        }

        const refreshHeaders: HeadersInit = {
            "User-Agent": constants.HEADERS.USER_AGENT,
            Accept: "application/json",
            "content-type": "application/json",
            username: username,
            Origin: constants.TANGO_URLS.HOME,
            [constants.HEADERS.COOKIE]: `${constants.COOKIE_NAMES.TANGO_RT_PREFIX}${tokenBag.refreshToken}`,
        };
        const refreshOptions = { method: "POST", headers: refreshHeaders };

        const response = await requestQueue.add<Response>(constants.TANGO_URLS.SESSION_REFRESH, refreshOptions);
        if (!response.ok) {
            throw new Error(`Session refresh failed with status ${response.status}. Refresh token may be expired.`);
        }

        const allCookies = response.headers.getSetCookie();
        let newSessionToken: string | null = null;
        let newRefreshToken: string | null = null;

        for (const cookieString of allCookies) {
            const trimmedCookie = cookieString.trim();
            if (trimmedCookie.startsWith(constants.COOKIE_NAMES.TANGO_ST_PREFIX)) {
                newSessionToken = trimmedCookie.split(";")[0].substring(constants.COOKIE_NAMES.TANGO_ST_PREFIX.length);
            } else if (trimmedCookie.startsWith(constants.COOKIE_NAMES.TANGO_RT_PREFIX)) {
                newRefreshToken = trimmedCookie.split(";")[0].substring(constants.COOKIE_NAMES.TANGO_RT_PREFIX.length);
            }
        }

        if (!newSessionToken) {
            throw new Error("Refresh endpoint did not return a new session token cookie.");
        }

        return { newSessionToken, newRefreshToken };
    }

    async fetchShortTokens(tokenBag: TokenBag): Promise<ShortTokenResult> {
        const options: RequestInit = {
            method: "GET",
            headers: { [constants.HEADERS.COOKIE]: `${constants.COOKIE_NAMES.TANGO_ST_PREFIX}${tokenBag.sessionToken}` },
        };
        const response = await requestQueue.add<Response>(constants.TANGO_URLS.TOKEN_DATA, options);

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

        return { extras: { tt, ttu, tte } };
    }

    extractUsername(refreshToken: string): string | null {
        const payload = authUtils.parseJwtPayload(refreshToken);
        return payload?.username || payload?.sessionId || null;
    }

    serializeTokens(bag: TokenBag): Record<string, any> {
        return {
            tangoRT: bag.refreshToken,
            tangoST: bag.sessionToken,
            tt: bag.extras.tt ?? null,
            ttu: bag.extras.ttu ?? null,
            tte: bag.extras.tte ?? null,
        };
    }

    deserializeTokens(data: Record<string, any>): TokenBag | null {
        if (!data.tangoRT) return null;
        return {
            refreshToken: data.tangoRT,
            sessionToken: data.tangoST ?? null,
            extras: {
                tt: data.tt ?? null,
                ttu: data.ttu ?? null,
                tte: data.tte ?? null,
            },
        };
    }
}
