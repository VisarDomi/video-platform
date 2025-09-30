// src/auth/tokenManager.ts
import * as timersPromises from "timers/promises";
import * as config from "../config.js";
import logger from "../logger.js";
import { AuthContext } from "./authContext.js";
import { extractTokensWithPuppeteer } from "./puppeteerLogin.js";
import * as authClient from "./authClient.js"; // <-- NEW IMPORT

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
                const loaded = await this.authContext.loadTokenFromFile();
                if (loaded) {
                    logger.info("Tango-RT loaded from file. Attempting to refresh session...");
                    try {
                        await this.refreshSession();
                        await this.setTokenData();
                        logger.info("Session successfully refreshed using token from file.");
                        success = true;
                        continue;
                    } catch (error) {
                        logger.warn(
                            "Failed to refresh session using token from file. Falling back to full Puppeteer login.",
                            { error: (error as Error).message }
                        );
                    }
                }
                logger.info("Performing full login via Puppeteer to get new tokens...");
                await this.extractInitialTokens();
                await this.setTokenData();
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

    private async extractInitialTokens() {
        const { tangoRT, tangoST } = await extractTokensWithPuppeteer();
        this.authContext.setTangoRT(tangoRT);
        this.authContext.setTangoST(tangoST);
        await this.authContext.saveTokenToFile();
    }

    // --- REFACTORED: Uses authClient ---
    private async refreshSession() {
        logger.info("Attempting to refresh session using Tango-RT...");
        const tangoRT = this.authContext.getTangoRT();
        if (!tangoRT) {
            throw new Error("Tango-RT not found in auth context. Cannot refresh session.");
        }
        const payload = this.parseJwtPayload(tangoRT);
        const username = payload?.username || payload?.sessionId;
        if (!username) {
            throw new Error("Could not extract username/sessionId from Tango-RT JWT.");
        }
        
        const result = await authClient.refreshSession(username, tangoRT);
        if (!result || !result.newTangoST) {
            throw new Error("Refresh endpoint did not return a new Tango-ST cookie.");
        }

        this.authContext.setTangoST(result.newTangoST);
        
        if (result.newTangoRT) {
            this.authContext.setTangoRT(result.newTangoRT);
            await this.authContext.saveTokenToFile();
            logger.info("Successfully refreshed Tango-ST and received a new Tango-RT.");
        } else {
            logger.warn("Successfully refreshed Tango-ST, but a new Tango-RT was not provided in the response.");
        }
    }

    // --- REFACTORED: Uses authClient ---
    private async setTokenData() {
        const tangoST = this.authContext.getTangoST();
        if (!tangoST) {
            throw new Error("Cannot fetch token data without Tango-ST.");
        }

        const result = await authClient.fetchTokenData(tangoST);
        if (!result || !result.tt || !result.ttu || !result.tte) {
            logger.error("Could not find all required cookies (tt, ttu, tte).", { result });
            throw new Error("Missing required cookies from tokenData response.");
        }

        this.authContext.setTt(result.tt);
        this.authContext.setTtu(result.ttu);
        this.authContext.setTte(result.tte);
    }

    private parseJwtPayload(token: string): { [key: string]: any } | null {
        try {
            const base64Url = token.split(".")[1];
            if (!base64Url) return null;
            const jsonPayload = Buffer.from(base64Url, "base64").toString();
            return JSON.parse(jsonPayload);
        } catch (error) {
            logger.error("Failed to parse JWT payload", { token, error });
            return null;
        }
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
                    await this.extractInitialTokens();
                    await this.setTokenData();
                    logger.info("Successfully re-authenticated via Puppeteer and refreshed all tokens.");
                } catch (fatalError) {
                    logger.error("CRITICAL: The fallback Puppeteer re-authentication also failed.", { fatalError });
                }
            }
        }
    }
}