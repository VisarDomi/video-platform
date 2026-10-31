import * as timersPromises from "timers/promises";

import logger from "../common/logger.js";
import { Account, IAuthProvider, BrowserVerificationRequiredError, BrowserLoginNeedsAttentionError } from "../providers/interfaces.js";
import { AuthContext } from "./authContext.js";
import { loginQueue } from "../browser/loginQueue.js";
import { parseJwtPayload } from "./authUtils.js";

const AUTH_LOGIN_RETRY_MS = 30_000;
const SHORT_REFRESH_RETRY_MS = 1_000;
// A refresh unanswered after this long gets a second, parallel request.
const SHORT_REFRESH_HEDGE_MS = 1_000;
// A stream-token request otherwise; Tango's stream token lives 10 seconds.
const SHORT_TOKEN_REQUEST_TIMEOUT_MS = 10_000;

export class AuthService {
    private readonly account: Account;
    private readonly provider: IAuthProvider;
    private readonly authContext: AuthContext;
    private browserLoginBlocked = false;
    private maintaining: Promise<void> | null = null;
    private forceSessionRefresh = false;

    constructor(account: Account, provider: IAuthProvider) {
        this.account = account;
        this.provider = provider;
        this.authContext = new AuthContext(account.email, provider);
    }

    public async initiateAuth() {
        const loadedFromFile = await this.authContext.loadTokenFromFile();

        if (loadedFromFile && !this.provider.needsSessionMigration?.(this.authContext.getTokenBag()!)) {
            logger.info(`Refresh token for ${this.account.email} loaded from file. Attempting to establish session...`);
            // A freshly recovered access token is already usable. Validate it with the
            // stream-token endpoint before consuming its rotating refresh token again.
            const expires = parseJwtPayload(this.authContext.getSessionToken() ?? "")?.exp;
            let reuseSession = typeof expires === "number" && expires * 1000 > Date.now() + 60_000;
            while (true) {
                try {
                    if (reuseSession) {
                        await this.setTokenData();
                        await this.authContext.saveTokenToFile();
                        this.logTokenWrite("resume");
                    } else { await this.ensureValidTokens("init"); }
                    logger.info(`Session successfully established for ${this.account.email} using token from file.`);
                    return;
                } catch (error) {
                    const errorMessage = (error as Error).message;
                    if (error instanceof BrowserVerificationRequiredError || errorMessage.includes("failed with status 401") || errorMessage.includes("failed with status 403")) {
                        if (reuseSession) { reuseSession = false; continue; }
                        logger.warn(error instanceof BrowserVerificationRequiredError
                            ? `Tango requested browser verification for ${this.account.email}; completing the normal browser login.`
                            : `Stored token is invalid. Falling back to browser login for ${this.account.email}.`);
                        break;
                    } else {
                        logger.error(`Failed to establish session for ${this.account.email}: ${errorMessage}. Retrying...`);
                        await timersPromises.setTimeout(AUTH_LOGIN_RETRY_MS);
                    }
                }
            }
        }

        logger.info(`Proceeding to browser login for ${this.account.email}.`);
        while (true) {
            try {
                await this.performFreshLogin();
                logger.info(`Session successfully established for ${this.account.email} via fresh browser login.`);
                return;
            } catch (error) {
                if (error instanceof BrowserLoginNeedsAttentionError) throw error;
                const errorMessage = (error as Error).message;
                logger.error(`Browser login failed for ${this.account.email}: ${errorMessage}. Retrying...`);
                await timersPromises.setTimeout(AUTH_LOGIN_RETRY_MS);
            }
        }
    }

    public startBackgroundJobs() {
        void this.refreshShortLivedTokens();
        void this.manageTokenLifecycle();
    }

    private async performFreshLogin() {
        if (this.browserLoginBlocked) throw new BrowserLoginNeedsAttentionError();
        logger.info(`Adding full browser login for ${this.account.email} to the queue...`);
        const tokens = await loginQueue.add(this.account, this.provider);
        this.authContext.updateFromLogin(tokens);
        await this.authContext.saveTokenToFile();
        this.forceSessionRefresh = false;
        await this.setTokenData();
        await this.authContext.saveTokenToFile();
        this.logTokenWrite("login");
    }

    private async ensureValidTokens(source: string) {
        const expires = parseJwtPayload(this.authContext.getSessionToken() ?? "")?.exp;
        const recoveredSession = !this.forceSessionRefresh && source === "session-maintain" && typeof expires === "number"
            && expires * 1000 > Date.now() + this.provider.intervals.sessionRefresh + 60_000;
        if (!recoveredSession) await this.refreshSession();
        await this.setTokenData();
        await this.authContext.saveTokenToFile();

        this.forceSessionRefresh = false;
        this.logTokenWrite(source);
    }

    private logTokenWrite(source: string): void {
        const tte = this.authContext.getTokenBag()?.extras?.tte;
        if (!tte) {
            logger.warn(`[Tango] Token write — source=${source} tte=none`);
            return;
        }
        const ttl = parseInt(tte, 10) - Math.floor(Date.now() / 1000);
        const refreshCycleSec = this.provider.intervals.shortTokenRefresh / 1000;
        if (ttl < refreshCycleSec) {
            logger.warn(`[Tango] Token write — source=${source} tte=${tte} ttl=${ttl}s (below ${refreshCycleSec}s refresh cycle)`);
        } else {
            logger.debug(`[Tango] Token write — source=${source} tte=${tte} ttl=${ttl}s`);
        }
    }

    private async refreshSession() {
        logger.debug(`Attempting to refresh session for ${this.account.email} using refresh token...`);
        const tokenBag = this.authContext.getTokenBag();
        if (!tokenBag) {
            throw new Error(`Refresh token not found for ${this.account.email}.`);
        }

        const result = await this.provider.refreshSession(tokenBag);
        const receivedNewRT = this.authContext.updateFromRefresh(result);
        // The previous RT is consumed. Commit its replacement before requesting
        // stream tokens, which can fail independently or be interrupted.
        await this.authContext.saveTokenToFile();
        this.forceSessionRefresh = false;

        if (receivedNewRT) {
            logger.debug(`Successfully refreshed session token and refresh token for ${this.account.email}.`);
        } else {
            logger.warn(`Refreshed session token, but no new refresh token was provided for ${this.account.email}.`);
        }
    }

    // hedged: a second request starts if the first has not answered within
    // SHORT_REFRESH_HEDGE_MS; the first answer wins. Most refresh failures are
    // one request that hangs while a fresh one answers in a fraction of a
    // second, and a merely slow API is not cut off as an abort would.
    private async setTokenData(hedged = false) {
        const tokenBag = this.authContext.getTokenBag();
        if (!tokenBag?.sessionToken) {
            throw new Error(`Cannot fetch token data for ${this.account.email} without session token.`);
        }
        const attempt = () => this.provider.fetchShortTokens(tokenBag, SHORT_TOKEN_REQUEST_TIMEOUT_MS);
        const first = attempt();
        let result;
        if (!hedged) {
            result = await first;
        } else {
            let answered = false;
            first.then(() => { answered = true; }, () => { answered = true; });
            const second = timersPromises.setTimeout(SHORT_REFRESH_HEDGE_MS).then(() => answered ? first : attempt());
            try {
                result = await Promise.any([first, second]);
            } catch (error) {
                throw error instanceof AggregateError ? error.errors[0] : error;
            }
        }
        if (this.authContext.getTokenBag() !== tokenBag) return;
        if(result.session)this.authContext.updateFromRefresh(result.session);
        this.authContext.updateFromTokenData(result);
    }

    private async refreshShortLivedTokens() {
        let consecutiveOk = 0;
        let consecutiveFail = 0;
        let wasHealthy = true;

        // The stream token outlives one refresh cycle by a single cycle, so the
        // cadence runs from the start of each refresh (a slow answer does not
        // push the next one later), each refresh is hedged, and a failure is
        // retried at once.
        while (true) {
            const startedAt = Date.now();
            try {
                await this.setTokenData(true);
                await this.authContext.saveTokenToFile();
                consecutiveOk++;
                if (!wasHealthy) {
                    logger.info(`[Tango] Short-refresh recovered after ${consecutiveFail} failures — tte=${this.authContext.getTokenBag()?.extras?.tte}`);
                    wasHealthy = true;
                    consecutiveFail = 0;
                }
                await timersPromises.setTimeout(Math.max(0, this.provider.intervals.shortTokenRefresh - (Date.now() - startedAt)));
            } catch (error) {
                consecutiveFail++;
                if ((error instanceof BrowserVerificationRequiredError || /failed with status (401|403)\b/.test((error as Error).message)) && !this.browserLoginBlocked) {
                    this.forceSessionRefresh = true;
                    await this.maintainSession();
                }
                if (wasHealthy) {
                    logger.warn(`[Tango] Short-refresh failed for ${this.account.email} after ${consecutiveOk} successes: ${(error as Error).message}`);
                    wasHealthy = false;
                    consecutiveOk = 0;
                }
                await timersPromises.setTimeout(this.browserLoginBlocked ? AUTH_LOGIN_RETRY_MS : SHORT_REFRESH_RETRY_MS);
            }
        }
    }

    private async manageTokenLifecycle() {
        while (true) {
            if (this.browserLoginBlocked) return;
            const expires = parseJwtPayload(this.authContext.getSessionToken() ?? "")?.exp;
            const delay = typeof expires === "number" ? Math.max(30_000, Math.min(this.provider.intervals.sessionRefresh, expires * 1000 - Date.now() - 300_000)) : this.provider.intervals.sessionRefresh;
            await timersPromises.setTimeout(delay);
            await this.maintainSession();
        }
    }

    private async maintainSession() {
        if (this.browserLoginBlocked) return;
        if (this.maintaining) return this.maintaining;
        const task = this.maintainSessionOnce();
        this.maintaining = task;
        try { await task; } finally { this.maintaining = null; }
    }

    private async maintainSessionOnce() {
        while (true) {
            try {
                await this.ensureValidTokens("session-maintain");
                logger.debug(`Session successfully maintained for ${this.account.email}.`);
                return;
            } catch (error) {
                if (error instanceof BrowserLoginNeedsAttentionError) {
                    this.browserLoginBlocked = true;
                    logger.error(error.message);
                    return;
                }
                const errorMessage = (error as Error).message;
                if (error instanceof BrowserVerificationRequiredError || errorMessage.includes("failed with status 401") || errorMessage.includes("failed with status 403")) {
                    logger.warn(error instanceof BrowserVerificationRequiredError
                        ? `Tango requested browser verification for ${this.account.email}; completing the normal browser login.`
                        : `Token became invalid during maintenance for ${this.account.email}. Attempting fresh browser login.`);
                    try {
                        await this.performFreshLogin();
                        logger.info(`Successfully re-authenticated via browser login for ${this.account.email}.`);
                        return;
                    } catch (loginError) {
                        if (loginError instanceof BrowserLoginNeedsAttentionError) {
                            this.browserLoginBlocked = true;
                            logger.error(loginError.message);
                            return;
                        }
                        logger.error(`Browser login failed during maintenance. Retrying after delay.`, { error: (loginError as Error).message });
                    }
                } else {
                    logger.warn(`Session maintenance failed for ${this.account.email}. Retrying after delay.`, { error: errorMessage });
                }
            }
            await timersPromises.setTimeout(AUTH_LOGIN_RETRY_MS);
        }
    }
}
