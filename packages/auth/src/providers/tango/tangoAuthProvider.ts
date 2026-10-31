import logger from "../../common/logger.js";
import { requestQueue } from "../../auth/authQueue.js";
import * as authUtils from "../../auth/authUtils.js";
import { Account, IAuthProvider, TokenBag, RefreshResult, ShortTokenResult, BrowserVerificationRequiredError } from "../interfaces.js";
import * as constants from "./constants.js";
import { BROWSER_STATE, rejectedSession } from "./tangoBrowserSession.js";
import { browserOwner, BROWSER_PROFILE } from "./tangoBrowserOwner.js";
import { createHash } from "node:crypto";

export class TangoAuthProvider implements IAuthProvider {
    constructor(private readonly browserRefresh?: (bag:TokenBag)=>Promise<RefreshResult>) {}
    readonly name = "tango";
    needsSessionMigration(bag:TokenBag):boolean{return !bag.extras[BROWSER_PROFILE];}

    readonly intervals = {
        shortTokenRefresh: constants.TANGO_STREAM_TOKEN_REFRESH_MS,
        sessionRefresh: constants.TANGO_SESSION_REFRESH_MS,
    };

    async login(account: Account): Promise<TokenBag> {
        return browserOwner("pc-"+createHash("sha256").update(account.email).digest("hex").slice(0,24)).session(account);
    }

    async refreshSession(tokenBag: TokenBag): Promise<RefreshResult> {
        if(this.browserRefresh&&tokenBag.extras[BROWSER_STATE])return this.browserRefresh(tokenBag);
        const profile=tokenBag.extras[BROWSER_PROFILE];
        if(profile){
            const fresh=await browserOwner(profile).session(undefined,300);
            return {newRefreshToken:fresh.refreshToken,newSessionToken:fresh.sessionToken!,browserProfile:profile};
        }
        if(tokenBag.extras[BROWSER_STATE])throw new BrowserVerificationRequiredError();
        const payload = authUtils.parseJwtPayload(tokenBag.refreshToken);
        const accountId = payload?.accountId;
        const sessionId = payload?.sessionId;
        if (typeof accountId !== "string" || !accountId || typeof sessionId !== "string" || !sessionId) {
            throw new Error("Refresh token is missing accountId or sessionId.");
        }

        const refreshHeaders: HeadersInit = {
            "User-Agent": constants.HEADERS.USER_AGENT,
            Accept: "application/json",
            "content-type": "application/json",
            Origin: "https://www.tango.me",
            Referer: "https://www.tango.me/",
            [constants.HEADERS.COOKIE]: `${constants.COOKIE_NAMES.TANGO_RT_PREFIX}${tokenBag.refreshToken}`,
        };
        const refreshOptions = { method: "POST", headers: refreshHeaders, body: JSON.stringify({ accountId, sessionId }), signal: AbortSignal.timeout(15_000) };

        const response = await requestQueue.add<Response>(constants.TANGO_URLS.SESSION_REFRESH, refreshOptions);
        if (!response.ok) {
            const details = await response.json().catch(() => null) as { errorCode?: string } | null;
            if (response.status === 424 && details?.errorCode === "CHALLENGE_REQUIRED") throw new BrowserVerificationRequiredError();
            if (rejectedSession(response.status, details)) throw new BrowserVerificationRequiredError();
            if (response.status === 401 || response.status === 403) throw new Error(`Tango session renewal was unavailable (HTTP ${response.status}).`);
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

    async fetchShortTokens(tokenBag: TokenBag, timeoutMs: number): Promise<ShortTokenResult> {
        const profile=tokenBag.extras[BROWSER_PROFILE];
        const current=profile ? await browserOwner(profile).session(undefined,15) : tokenBag;
        const options: RequestInit = {
            method: "GET",
            headers: { [constants.HEADERS.COOKIE]: `${constants.COOKIE_NAMES.TANGO_ST_PREFIX}${current.sessionToken}` },
            signal: AbortSignal.timeout(timeoutMs),
        };
        // Not through the request queue: it runs one request at a time, so a
        // hedged second request would wait behind the hung first one.
        const response = await fetch(constants.TANGO_URLS.TOKEN_DATA, options);

        if (!response.ok) {
            const details = await response.json().catch(() => null) as { errorCode?: string } | null;
            if(profile&&(response.status===401||rejectedSession(response.status,details)))browserOwner(profile).rejectAccess(current.sessionToken!);
            if (response.status === 424 && details?.errorCode === "CHALLENGE_REQUIRED") throw new BrowserVerificationRequiredError();
            if (response.status === 403 && !rejectedSession(response.status, details)) throw new Error("Tango stream-token request was unavailable (HTTP 403).");
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

        return { extras: { tt, ttu, tte }, ...(profile&&(current.refreshToken!==tokenBag.refreshToken||current.sessionToken!==tokenBag.sessionToken) ? {session:{newRefreshToken:current.refreshToken,newSessionToken:current.sessionToken!,browserProfile:profile}} : {}) };
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
            browserState: bag.extras[BROWSER_STATE] ?? null,
            browserProfile: bag.extras[BROWSER_PROFILE] ?? null,
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
                ...(typeof data.browserState === "string" ? {[BROWSER_STATE]: data.browserState} : {}),
                ...(typeof data.browserProfile === "string" ? {[BROWSER_PROFILE]: data.browserProfile} : {}),
            },
        };
    }
}
