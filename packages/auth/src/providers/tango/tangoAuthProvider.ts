import logger from "../../common/logger.js";
import { requestQueue } from "../../auth/authQueue.js";
import * as authUtils from "../../auth/authUtils.js";
import { Account, IAuthProvider, TokenBag, RefreshResult, ShortTokenResult } from "../interfaces.js";
import * as constants from "./constants.js";
import { extractTokens } from "./tangoLogin.js";

export class TangoAuthProvider implements IAuthProvider {
    readonly name = "tango";

    readonly intervals = {
        shortTokenRefresh: constants.TANGO_STREAM_TOKEN_REFRESH_MS,
        sessionRefresh: constants.TANGO_SESSION_REFRESH_MS,
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
        const newSessionToken = constants.extractCookie(allCookies, constants.COOKIE_NAMES.TANGO_ST_PREFIX);
        const newRefreshToken = constants.extractCookie(allCookies, constants.COOKIE_NAMES.TANGO_RT_PREFIX);

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
        const tt = constants.extractCookie(allCookies, constants.COOKIE_NAMES.TT_PREFIX);
        const ttu = constants.extractCookie(allCookies, constants.COOKIE_NAMES.TTU_PREFIX);
        const tte = constants.extractCookie(allCookies, constants.COOKIE_NAMES.TTE_PREFIX);

        if (!tt || !ttu || !tte) {
            throw new Error("Token data response was missing one or more required cookies (tt, ttu, tte).");
        }

        const ttl = parseInt(tte, 10) - Math.floor(Date.now() / 1000);
        if (ttl < constants.TANGO_STREAM_TOKEN_TTL_S * 0.8) {
            logger.warn(`[Tango] Tango API issued short-lived token: tte=${tte} ttl=${ttl}s (expected ~${constants.TANGO_STREAM_TOKEN_TTL_S}s)`);
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
