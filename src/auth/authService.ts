import * as timersPromises from "timers/promises";

import logger from "../common/logger.js";
import * as types from "../common/types.js";
import { AuthContext } from "./authContext.js";
import { loginQueue } from "../browser/loginQueue.js";
import * as authClient from "./authClient.js";
import * as authUtils from "./authUtils.js";

const AUTH_RETRY_INTERVAL_MS = 30 * 1000;
const BACKGROUND_JOB_FAILURE_RETRY_MS = 15 * 1000;

export class AuthService {
    private readonly account: types.Account;
    private readonly authContext: AuthContext;

    constructor(account: types.Account) {
        this.account = account;
        this.authContext = new AuthContext(account.email);
    }

    public async initiateAuth() {
        const loadedFromFile = await this.authContext.loadTokenFromFile();

        if (loadedFromFile) {
            logger.info(`Tango-RT for ${this.account.email} loaded from file. Attempting to establish session...`);
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
            try {
                const refreshInterval = 5000;
                await this.setTokenData();
                await this.authContext.saveTokenToFile();
                await timersPromises.setTimeout(refreshInterval);
            } catch (error) {
                logger.warn(`Failed to refresh short-lived tokens for ${this.account.email}. Retrying after delay.`, { error: (error as Error).message });
                await timersPromises.setTimeout(BACKGROUND_JOB_FAILURE_RETRY_MS);
            }
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