import * as timersPromises from "timers/promises";

import logger from "../common/logger.js";
import * as types from "../common/types.js";
import { AuthContext } from "./authContext.js";
import { loginQueue } from "../browser/loginQueue.js";
import * as authClient from "./authClient.js";
import * as authUtils from "./authUtils.js";

const REFRESH_RETRY_INTERVAL_MS = 15 * 1000;
const REFRESH_RETRY_DURATION_MS = 30 * 60 * 1000;

export class AuthService {
    private readonly account: types.Account;
    private readonly authContext: AuthContext;

    constructor(account: types.Account) {
        this.account = account;
        this.authContext = new AuthContext(account.email);
    }

    public async initiateAuth() {
        let success = false;
        while (!success) {
            try {
                await this.attemptAuthentication();
                success = true;
            } catch (error) {
                const errorMessage = (error as Error).message;
                logger.error(`Catastrophic auth failure for ${this.account.email}: ${errorMessage}. Retrying in 30 seconds...`);
                await timersPromises.setTimeout(30000);
            }
        }
    }

    private async attemptAuthentication() {
        const loadedFromFile = await this.authContext.loadTokenFromFile();

        if (loadedFromFile) {
            logger.info(`Tango-RT for ${this.account.email} loaded from file. Attempting to refresh session...`);

            const refreshSuccessful = await this.tryRefreshWithRetries();
            if (refreshSuccessful) {
                logger.info(`Session successfully established for ${this.account.email} using token from file.`);
                return;
            }
            logger.warn(`Refresh attempts failed for ${this.account.email}. Falling back to browser login.`);
        } else {
            logger.info(`No session file for ${this.account.email}. Proceeding to browser login.`);
        }

        await this.performFreshLogin();
        logger.info(`Session successfully established for ${this.account.email} via fresh browser login.`);
    }

    private async tryRefreshWithRetries(): Promise<boolean> {
        const startTime = Date.now();
        let attempt = 0;

        while (Date.now() - startTime < REFRESH_RETRY_DURATION_MS) {
            attempt++;
            try {
                await this.ensureValidTokens();
                return true;
            } catch (error) {
                const errorMessage = (error as Error).message;
                if (errorMessage.includes("failed with status 401") || errorMessage.includes("failed with status 403")) {
                    logger.warn(`Unrecoverable auth error for ${this.account.email}. Stopping retries.`, { error: errorMessage });
                    return false;
                }
                logger.warn(`Refresh attempt ${attempt} for ${this.account.email} failed. Retrying...`, { error: errorMessage });
                await timersPromises.setTimeout(REFRESH_RETRY_INTERVAL_MS);
            }
        }
        return false;
    }

    public startBackgroundJobs() {
        void this.refreshShortLivedTokens();
        void this.manageTokenLifecycle();
    }

    private async performFreshLogin() {
        logger.info(`Adding full browser login for ${this.account.email} to the queue...`);
        const tokens = await loginQueue.add(this.account);
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
        logger.info(`Attempting to refresh session for ${this.account.email} using Tango-RT...`);
        const tangoRT = this.authContext.getTangoRT();
        if (!tangoRT) {
            throw new Error(`Tango-RT not found for ${this.account.email}.`);
        }
        const payload = authUtils.parseJwtPayload(tangoRT);
        const username = payload?.username || payload?.sessionId;
        if (!username) {
            throw new Error(`Could not extract username from Tango-RT for ${this.account.email}.`);
        }

        const result = await authClient.refreshSession(username, tangoRT);
        const receivedNewRT = this.authContext.updateFromRefresh(result);

        if (receivedNewRT) {
            logger.info(`Successfully refreshed ST and RT for ${this.account.email}.`);
        } else {
            logger.warn(`Refreshed ST, but no new RT was provided for ${this.account.email}.`);
        }
    }

    private async setTokenData() {
        const tangoST = this.authContext.getTangoST();
        if (!tangoST) {
            throw new Error(`Cannot fetch token data for ${this.account.email} without Tango-ST.`);
        }
        const result = await authClient.fetchTokenData(tangoST);
        this.authContext.updateFromTokenData(result);
    }

    private async refreshShortLivedTokens() {
        while (true) {
            const refreshInterval = 5000;
            await this.setTokenData();
            await this.authContext.saveTokenToFile();
            await timersPromises.setTimeout(refreshInterval);
        }
    }

    private async manageTokenLifecycle() {
        while (true) {
            const refreshInterval = 30 * 60 * 1000;
            await timersPromises.setTimeout(refreshInterval);
            await this.maintainSession();
        }
    }

    private async maintainSession() {
        try {
            await this.ensureValidTokens();
        } catch (error) {
            logger.error(`Session maintenance failed for ${this.account.email}. Re-authenticating.`, { error });
            await this.performFreshLogin();
        }
    }
}