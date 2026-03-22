import * as timersPromises from "timers/promises";

import logger from "../common/logger.js";
import { Account, IAuthProvider } from "../providers/interfaces.js";
import { AuthContext } from "./authContext.js";
import { loginQueue } from "../browser/loginQueue.js";

const AUTH_RETRY_INTERVAL_MS = 30 * 1000;
const BACKGROUND_JOB_FAILURE_RETRY_MS = 15 * 1000;

export class AuthService {
    private readonly account: Account;
    private readonly provider: IAuthProvider;
    private readonly authContext: AuthContext;

    constructor(account: Account, provider: IAuthProvider) {
        this.account = account;
        this.provider = provider;
        this.authContext = new AuthContext(account.email, provider);
    }

    public async initiateAuth() {
        const loadedFromFile = await this.authContext.loadTokenFromFile();

        if (loadedFromFile) {
            logger.info(`Refresh token for ${this.account.email} loaded from file. Attempting to establish session...`);
            while (true) {
                try {
                    await this.ensureValidTokens();
                    logger.info(`Session successfully established for ${this.account.email} using token from file.`);
                    return;
                } catch (error) {
                    const errorMessage = (error as Error).message;
                    if (errorMessage.includes("failed with status 401") || errorMessage.includes("failed with status 403")) {
                        logger.warn(`Stored token is invalid. Falling back to browser login for ${this.account.email}.`);
                        break;
                    } else {
                        logger.error(`Failed to establish session for ${this.account.email}: ${errorMessage}. Retrying...`);
                        await timersPromises.setTimeout(AUTH_RETRY_INTERVAL_MS);
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
                const errorMessage = (error as Error).message;
                logger.error(`Browser login failed for ${this.account.email}: ${errorMessage}. Retrying...`);
                await timersPromises.setTimeout(AUTH_RETRY_INTERVAL_MS);
            }
        }
    }

    public startBackgroundJobs() {
        void this.refreshShortLivedTokens();
        void this.manageTokenLifecycle();
    }

    private async performFreshLogin() {
        logger.info(`Adding full browser login for ${this.account.email} to the queue...`);
        const tokens = await loginQueue.add(this.account, this.provider);
        this.authContext.updateFromLogin(tokens);
        await this.setTokenData();
        await this.authContext.saveTokenToFile();
    }

    private async ensureValidTokens() {
        await this.refreshSession();
        await this.setTokenData();
        await this.authContext.saveTokenToFile();
    }

    private async refreshSession() {
        logger.info(`Attempting to refresh session for ${this.account.email} using refresh token...`);
        const tokenBag = this.authContext.getTokenBag();
        if (!tokenBag) {
            throw new Error(`Refresh token not found for ${this.account.email}.`);
        }

        const result = await this.provider.refreshSession(tokenBag);
        const receivedNewRT = this.authContext.updateFromRefresh(result);

        if (receivedNewRT) {
            logger.info(`Successfully refreshed session token and refresh token for ${this.account.email}.`);
        } else {
            logger.warn(`Refreshed session token, but no new refresh token was provided for ${this.account.email}.`);
        }
    }

    private async setTokenData() {
        const tokenBag = this.authContext.getTokenBag();
        if (!tokenBag?.sessionToken) {
            throw new Error(`Cannot fetch token data for ${this.account.email} without session token.`);
        }
        const result = await this.provider.fetchShortTokens(tokenBag);
        this.authContext.updateFromTokenData(result);
    }

    private async refreshShortLivedTokens() {
        while (true) {
            try {
                await this.setTokenData();
                await this.authContext.saveTokenToFile();
                await timersPromises.setTimeout(this.provider.intervals.shortTokenRefresh);
            } catch (error) {
                const tte = this.authContext.getTokenBag()?.extras?.tte;
                const ttl = tte ? parseInt(tte, 10) - Math.floor(Date.now() / 1000) : -1;
                logger.warn(`Failed to refresh short-lived tokens for ${this.account.email}. On-disk tokens have ttl=${ttl}s. Retrying in ${BACKGROUND_JOB_FAILURE_RETRY_MS / 1000}s.`, { error: (error as Error).message });
                await timersPromises.setTimeout(BACKGROUND_JOB_FAILURE_RETRY_MS);
            }
        }
    }

    private async manageTokenLifecycle() {
        while (true) {
            await timersPromises.setTimeout(this.provider.intervals.sessionRefresh);
            await this.maintainSession();
        }
    }

    private async maintainSession() {
        while (true) {
            try {
                await this.ensureValidTokens();
                logger.info(`Session successfully maintained for ${this.account.email}.`);
                return;
            } catch (error) {
                const errorMessage = (error as Error).message;
                if (errorMessage.includes("failed with status 401") || errorMessage.includes("failed with status 403")) {
                    logger.warn(`Token became invalid during maintenance for ${this.account.email}. Attempting fresh browser login.`);
                    try {
                        await this.performFreshLogin();
                        logger.info(`Successfully re-authenticated via browser login for ${this.account.email}.`);
                        return;
                    } catch (loginError) {
                        logger.error(`Browser login failed during maintenance. Retrying after delay.`, { error: (loginError as Error).message });
                    }
                } else {
                    logger.warn(`Session maintenance failed for ${this.account.email}. Retrying after delay.`, { error: errorMessage });
                }
            }
            await timersPromises.setTimeout(BACKGROUND_JOB_FAILURE_RETRY_MS);
        }
    }
}
