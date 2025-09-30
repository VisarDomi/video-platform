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
                const refreshed = await this.tryLoadAndRefreshFromFile();
                if (refreshed) {
                    logger.info("Session successfully refreshed using token from file.");
                    success = true;
                    continue;
                }

                logger.info("Performing full login via Puppeteer to get new tokens...");
                await this.performFreshLogin();
                success = true;

            } catch (error) {
                const errorMessage = (error as Error).message;
                logger.error(`Initial authentication failed: ${errorMessage}. Retrying in 30 seconds...`);
                await timersPromises.setTimeout(30000);
            }
        }
    }
    
    public async startBackgroundJobs() {
        this.refreshShortLivedTokens();
        this.manageTokenLifecycle();
    }
    
    private async tryLoadAndRefreshFromFile(): Promise<boolean> {
        const loaded = await this.authContext.loadTokenFromFile();
        if (loaded) {
            logger.info("Tango-RT loaded from file. Attempting to refresh session...");
            try {
                await this.refreshSession();
                await this.setTokenData();
                return true;
            } catch (error) {
                logger.warn(
                    "Failed to refresh session using token from file. Falling back to full Puppeteer login.",
                    { error: (error as Error).message }
                );
                return false;
            }
        }
        return false;
    }

    private async performFreshLogin() {
        await this.extractInitialTokens();
        await this.setTokenData();
    }

    private async extractInitialTokens() {
        const { tangoRT, tangoST } = await extractTokensWithPuppeteer();
        this.authContext.setTangoRT(tangoRT);
        this.authContext.setTangoST(tangoST);
        await this.authContext.saveTokenToFile();
    }

    private async refreshSession() {
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
        
        // This is now much cleaner. We know the result is valid if no error is thrown.
        const { newTangoST, newTangoRT } = await authClient.refreshSession(username, tangoRT);

        this.authContext.setTangoST(newTangoST);
        
        if (newTangoRT) {
            this.authContext.setTangoRT(newTangoRT);
            await this.authContext.saveTokenToFile();
            logger.info("Successfully refreshed Tango-ST and received a new Tango-RT.");
        } else {
            logger.warn("Successfully refreshed Tango-ST, but a new Tango-RT was not provided in the response.");
        }
    }

    private async setTokenData() {
        const tangoST = this.authContext.getTangoST();
        if (!tangoST) {
            throw new Error("Cannot fetch token data without Tango-ST.");
        }

        // Also much cleaner. All properties are guaranteed to exist.
        const { tt, ttu, tte } = await authClient.fetchTokenData(tangoST);

        this.authContext.setTt(tt);
        this.authContext.setTtu(ttu);
        this.authContext.setTte(tte);
    }
    
    private async refreshShortLivedTokens() {
        while (true) {
            try {
                await this.setTokenData();
            } catch (error) {
                logger.error("Failed to refresh short-lived tokens. Waiting for new Tango-ST.", { error });
            }
            await timersPromises.setTimeout(config.getConfig().intervals.shortTokenRefresh);
        }
    }

    private async manageTokenLifecycle() {
        while (true) {
            const refreshInterval = config.getConfig().intervals.longTokenRefreshMinutes * 60 * 1000;
            await timersPromises.setTimeout(refreshInterval);
            try {
                await this.refreshSession();
                await this.setTokenData();
            } catch (error) {
                logger.error("Lightweight session refresh failed. Falling back to full Puppeteer re-authentication.", { error });
                try {
                    await this.performFreshLogin();
                    logger.info("Successfully re-authenticated via Puppeteer and refreshed all tokens.");
                } catch (fatalError) {
                    logger.error("CRITICAL: The fallback Puppeteer re-authentication also failed.", { fatalError });
                }
            }
        }
    }
}