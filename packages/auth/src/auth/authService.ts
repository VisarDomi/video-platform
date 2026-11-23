import * as timersPromises from "timers/promises";

import type { AuthDecision, Logger, ShortTokens, SiteAuth, TokenBag } from "sdk";
import { CredentialStore, taggedLogger } from "shared";
import logger from "../common/logger.js";
import { getConfig } from "../common/config.js";
import { AuthContext } from "./authContext.js";
import { loginQueue } from "../browser/loginQueue.js";
import type { Account } from "../accounts.js";

const AUTH_LOGIN_RETRY_MS = 30_000;
const SHORT_REFRESH_RETRY_MS = 1_000;
// A refresh unanswered after this long gets a second, parallel request.
const SHORT_REFRESH_HEDGE_MS = 1_000;
// A short-lived-token request otherwise (the token it renews may live only seconds).
const SHORT_TOKEN_REQUEST_TIMEOUT_MS = 10_000;

export interface AuthSite {
    // The plug-in's label: names the site in log lines ("<label> requested ...").
    label: string;
    // The site's logger ("[<label>] ...").
    log: Logger;
    store: CredentialStore;
}

// Keeps one account signed in on one site: restores the saved session at start (or signs
// in with the browser), renews the short-lived tokens and the session on the site's
// cadence, saves every change to the credential store, and decides from the site's
// classify() when to sign in again, when to wait out an outage and when to stop.
export class AuthService {
    private readonly account: Account;
    private readonly provider: SiteAuth;
    private readonly authContext: AuthContext;
    private readonly label: string;
    private readonly siteLog: Logger;
    private browserLoginBlocked = false;
    // The failure that stopped automatic sign-ins; any later sign-in reports it again.
    private blockedBy: unknown = null;
    private maintaining: Promise<void> | null = null;
    private forceSessionRefresh = false;

    constructor(account: Account, provider: SiteAuth, site: Partial<AuthSite> = {}) {
        this.account = account;
        this.provider = provider;
        this.label = site.label ?? account.provider;
        this.siteLog = site.log ?? taggedLogger(logger, this.label);
        this.authContext = new AuthContext(account.email, provider, site.store ?? new CredentialStore(getConfig().sessionPath));
    }

    // The site's decision for a failure: sign in again ("reauthenticate", or "verification"
    // when the site asked for its interactive check), stop ("needs-attention") or wait.
    private decide(error: unknown): AuthDecision {
        return this.provider.classify(error);
    }

    private reauthenticates(decision: AuthDecision): boolean {
        return decision === "reauthenticate" || decision === "verification" || decision === "expired";
    }

    private sessionExpiresAt(): number | undefined {
        const bag = this.authContext.getTokenBag();
        return bag ? this.provider.describeTokens(bag).sessionExpiresAt : undefined;
    }

    public async initiateAuth() {
        const loadedFromFile = await this.authContext.loadTokenFromFile();

        const migrating = loadedFromFile && !!this.provider.needsSessionMigration?.(this.authContext.getTokenBag()!);
        let reason = !loadedFromFile ? "no saved session" : migrating ? "the saved session predates its current format" : "";
        let expected = false;
        if (loadedFromFile && !migrating) {
            logger.info(`Refresh token for ${this.account.email} loaded from file. Attempting to establish session...`);
            // A freshly recovered access token is already usable. Validate it with the
            // stream-token endpoint before consuming its rotating refresh token again.
            const expires = this.sessionExpiresAt();
            let reuseSession = expires !== undefined && expires > Date.now() + 60_000;
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
                    const decision = this.decide(error);
                    if (this.reauthenticates(decision)) {
                        if (reuseSession) { reuseSession = false; continue; }
                        logger.warn(decision === "verification"
                            ? `${this.label} requested browser verification for ${this.account.email}; completing the normal browser login.`
                            : `Stored token is invalid. Falling back to browser login for ${this.account.email}.`);
                        reason = `the saved session was refused: ${errorMessage}`;
                        expected = decision === "expired";
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
                await this.performFreshLogin(reason, expected);
                logger.info(`Session successfully established for ${this.account.email} via fresh browser login.`);
                return;
            } catch (error) {
                if (this.decide(error) === "needs-attention") throw error;
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

    // A browser sign-in. The session is meant to live on its refresh token: the one expected
    // sign-in is at the token's own expiry; any other is a bug event, logged as an error with
    // its cause for the daily check.
    private async performFreshLogin(reason = "unspecified", expected = false) {
        if (this.browserLoginBlocked) throw this.blockedBy;
        if (expected) logger.info(`${this.label} browser sign-in for ${this.account.email}: ${reason}`);
        else logger.error(`[bug event] ${this.label} browser sign-in for ${this.account.email}: ${reason}`);
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
        const expires = this.sessionExpiresAt();
        const recoveredSession = !this.forceSessionRefresh && source === "session-maintain" && expires !== undefined
            && expires > Date.now() + this.provider.intervals.sessionRefresh + 60_000;
        if (!recoveredSession) await this.refreshSession();
        await this.setTokenData();
        await this.authContext.saveTokenToFile();

        this.forceSessionRefresh = false;
        this.logTokenWrite(source);
    }

    // The short-lived tokens just saved, as the site names them, and whether they outlive
    // the next short refresh.
    private logTokenWrite(source: string): void {
        const bag = this.authContext.getTokenBag();
        const tokens = bag ? this.provider.describeTokens(bag) : { summary: "" };
        if (!bag || tokens.shortExpiresAt === undefined) {
            this.siteLog.warn(`Token write — source=${source} ${bag ? tokens.summary : this.noTokensSummary()}`);
            return;
        }
        const ttl = Math.floor(tokens.shortExpiresAt / 1000) - Math.floor(Date.now() / 1000);
        const refreshCycleSec = this.provider.intervals.shortTokenRefresh / 1000;
        if (ttl < refreshCycleSec) {
            this.siteLog.warn(`Token write — source=${source} ${tokens.summary} ttl=${ttl}s (below ${refreshCycleSec}s refresh cycle)`);
        } else {
            this.siteLog.debug(`Token write — source=${source} ${tokens.summary} ttl=${ttl}s`);
        }
    }

    // How the site names "no short-lived tokens" (a bag without any).
    private noTokensSummary(): string {
        return this.provider.describeTokens({ refreshToken: "", sessionToken: null, extras: {} }).summary;
    }

    private async refreshSession() {
        logger.debug(`Attempting to refresh session for ${this.account.email} using refresh token...`);
        const tokenBag = this.authContext.getTokenBag();
        if (!tokenBag) {
            throw new Error(`Refresh token not found for ${this.account.email}.`);
        }

        const startedAt = Date.now();
        const result = await this.provider.refreshSession(tokenBag);
        const receivedNewRT = this.authContext.updateFromRefresh(result);
        this.siteLog.info(`Session renewed by refresh token in ${Date.now() - startedAt} ms${receivedNewRT ? " (rotated)" : ""}`);
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
        const current = this.authContext.getTokenBag();
        if (current !== tokenBag) {
            // A session renewal replaced the bag while this request ran. Its session must not
            // come back, but its short-lived tokens are still valid and may be newer than the
            // ones saved: dropping them left the stream tokens to lapse during a renewal.
            if (current && this.newerShortTokens(current, result.extras)) this.authContext.updateFromTokenData({ extras: result.extras });
            return;
        }
        if(result.session)this.authContext.updateFromRefresh(result.session);
        this.authContext.updateFromTokenData(result);
    }

    private newerShortTokens(bag: TokenBag, extras: ShortTokens["extras"]): boolean {
        const offered = this.provider.describeTokens({ ...bag, extras: { ...bag.extras, ...extras } }).shortExpiresAt;
        const held = this.provider.describeTokens(bag).shortExpiresAt;
        return offered !== undefined && (held === undefined || offered > held);
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
                    const bag = this.authContext.getTokenBag();
                    this.siteLog.info(`Short-refresh recovered after ${consecutiveFail} failures — ${bag ? this.provider.describeTokens(bag).summary : this.noTokensSummary()}`);
                    wasHealthy = true;
                    consecutiveFail = 0;
                }
                await timersPromises.setTimeout(Math.max(0, this.provider.intervals.shortTokenRefresh - (Date.now() - startedAt)));
            } catch (error) {
                consecutiveFail++;
                if (this.reauthenticates(this.decide(error)) && !this.browserLoginBlocked) {
                    this.forceSessionRefresh = true;
                    await this.maintainSession();
                }
                if (wasHealthy) {
                    this.siteLog.warn(`Short-refresh failed for ${this.account.email} after ${consecutiveOk} successes: ${(error as Error).message}`);
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
            const expires = this.sessionExpiresAt();
            const delay = expires !== undefined ? Math.max(30_000, Math.min(this.provider.intervals.sessionRefresh, expires - Date.now() - 300_000)) : this.provider.intervals.sessionRefresh;
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
                const decision = this.decide(error);
                if (decision === "needs-attention") {
                    this.block(error);
                    return;
                }
                const errorMessage = (error as Error).message;
                if (this.reauthenticates(decision)) {
                    logger.warn(decision === "verification"
                        ? `${this.label} requested browser verification for ${this.account.email}; completing the normal browser login.`
                        : `Token became invalid during maintenance for ${this.account.email}. Attempting fresh browser login.`);
                    try {
                        await this.performFreshLogin(decision === "expired" ? errorMessage : `the session renewal was refused: ${errorMessage}`,
                            decision === "expired");
                        logger.info(`Successfully re-authenticated via browser login for ${this.account.email}.`);
                        return;
                    } catch (loginError) {
                        if (this.decide(loginError) === "needs-attention") {
                            this.block(loginError);
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

    // A person has to act: automatic sign-ins stop until the daemon restarts.
    private block(error: unknown): void {
        this.browserLoginBlocked = true;
        this.blockedBy = error;
        logger.error((error as Error).message);
    }
}
