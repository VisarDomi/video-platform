// src/auth/tokenManager.ts
import * as timersPromises from "timers/promises";
import * as config from "../config.js";
import logger from "../logger.js";
import { AuthContext } from "./authContext.js";
import { extractTokensWithPuppeteer } from "./puppeteerLogin.js";
import * as authClient from "./authClient.js";
import { parseJwtPayload } from "./authUtils.js";

export class TokenManager {
    private authContext: AuthContext;

    constructor() {
        this.authContext = new AuthContext();
    }
    
    public getAuthContext(): AuthContext {
        return this.authContext;
    }

    public async initialAuth() {
        let success = false;
        while (!success) {
            try {
                // The core authentication flow, now simplified.
                await this._attemptAuthentication();
                success = true;

            } catch (error) {
                const errorMessage = (error as Error).message;
                logger.error(`Catastrophic authentication failure: ${errorMessage}. Retrying in 30 seconds...`);
                await timersPromises.setTimeout(30000);
            }
        }
    }
    
    /**
     * Attempts the full authentication sequence. Tries the fast path (refresh from file)
     * first, and falls back to the slow path (Puppeteer login) if the fast path fails.
     * @throws Will throw if the fallback path also fails.
     */
    private async _attemptAuthentication() {
        try {
            await this._tryLoadAndRefreshFromFile();
            logger.info("Session successfully established using token from file.");
        } catch (error) {
            logger.warn(`Could not refresh from file, falling back to Puppeteer. Reason: ${(error as Error).message}`);
            await this._performFreshLogin();
            logger.info("Session successfully established via fresh Puppeteer login.");
        }
    }
    
    /**
     * Tries to load a token from session.json and refresh it.
     * @throws Throws an error if loading or refreshing fails.
     */
    private async _tryLoadAndRefreshFromFile(): Promise<void> {
        const loaded = await this.authContext.loadTokenFromFile();
        if (!loaded) {
            throw new Error("Session file not found or is invalid.");
        }
        
        logger.info("Tango-RT loaded from file. Attempting to refresh session...");
        await this._refreshSession();
        await this._setTokenData();
    }
    
    public startBackgroundJobs() {
        this._refreshShortLivedTokens();
        this._manageTokenLifecycle();
    }

    private async _performFreshLogin() {
        logger.info("Performing full login via Puppeteer to get new tokens...");
        await this._extractInitialTokens();
        await this._setTokenData();
    }

    private async _extractInitialTokens() {
        const tokens = await extractTokensWithPuppeteer();
        this.authContext.updateFromLogin(tokens);
        await this.authContext.saveTokenToFile();
    }

    private async _refreshSession() {
        logger.info("Attempting to refresh session using Tango-RT...");
        const tangoRT = this.authContext.getTangoRT();
        if (!tangoRT) {
            throw new Error("Tango-RT not found in auth context. Cannot refresh session.");
        }
        const payload = parseJwtPayload(tangoRT);
        const username = payload?.username || payload?.sessionId;
        if (!username) {
            throw new Error("Could not extract username/sessionId from Tango-RT JWT.");
        }
        
        const result = await authClient.refreshSession(username, tangoRT);
        const receivedNewRT = this.authContext.updateFromRefresh(result);
        
        if (receivedNewRT) {
            await this.authContext.saveTokenToFile();
            logger.info("Successfully refreshed Tango-ST and received a new Tango-RT.");
        } else {
            logger.warn("Successfully refreshed Tango-ST, but a new Tango-RT was not provided in the response.");
        }
    }

    private async _setTokenData() {
        const tangoST = this.authContext.getTangoST();
        if (!tangoST) {
            throw new Error("Cannot fetch token data without Tango-ST.");
        }

        const result = await authClient.fetchTokenData(tangoST);
        this.authContext.updateFromTokenData(result);
    }
    
    private async _refreshShortLivedTokens() {
        while (true) {
            try {
                await this._setTokenData();
            } catch (error) {
                logger.error("Failed to refresh short-lived tokens. Waiting for new Tango-ST.", { error });
            }
            await timersPromises.setTimeout(config.getConfig().intervals.shortTokenRefresh);
        }
    }
    
    private async _manageTokenLifecycle() {
        while (true) {
            const refreshInterval = config.getConfig().intervals.longTokenRefreshMinutes * 60 * 1000;
            await timersPromises.setTimeout(refreshInterval);
            await this._maintainSession();
        }
    }
    
    private async _maintainSession() {
        try {
            await this._refreshSession();
            await this._setTokenData();
        } catch (error) {
            logger.error("Lightweight session refresh failed. Falling back to full Puppeteer re-authentication.", { error });
            try {
                await this._performFreshLogin();
                logger.info("Successfully re-authenticated via Puppeteer and refreshed all tokens.");
            } catch (fatalError) {
                logger.error("CRITICAL: The fallback Puppeteer re-authentication also failed.", { fatalError });
            }
        }
    }
}