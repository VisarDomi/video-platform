// src/auth/authService.ts
import * as timersPromises from "timers/promises";

import logger from "../common/logger.js";

import * as authContext from "./authContext.js";
import * as puppeteerLogin from "./puppeteerLogin.js";
import * as authClient from "./authClient.js";
import * as authUtils from "./authUtils.js";

// --- NEW CONSTANTS FOR RETRY LOGIC ---
const REFRESH_RETRY_INTERVAL_MS = 15 * 1000; // 15 seconds
const REFRESH_RETRY_DURATION_MS = 30 * 60 * 1000; // 30 minutes

export class AuthService {
    private authContext: authContext.AuthContext;

    constructor() {
        this.authContext = new authContext.AuthContext();
    }

    public getAuthContext(): authContext.AuthContext {
        return this.authContext;
    }

    public async initiateAuth() {
        let success = false;
        while (!success) {
            try {
                await this._attemptAuthentication();
                success = true;
            } catch (error) {
                const errorMessage = (error as Error).message;
                logger.error(`Catastrophic authentication failure: ${errorMessage}. Retrying in 30 seconds...`);
                await timersPromises.setTimeout(30000);
            }
        }
    }

    private async _attemptAuthentication() {
        const loadedFromFile = await this.authContext.loadTokenFromFile();

        if (loadedFromFile) {
            logger.info("Tango-RT loaded from file. Attempting to refresh session with retries...");

            const refreshSuccessful = await this._tryRefreshWithRetries();
            if (refreshSuccessful) {
                logger.info("Session successfully established using token from file.");
                return; // SUCCESS: Authentication is complete.
            }

            // If we reach here, it means all refresh retries failed.
            logger.warn(`All refresh attempts failed over ${REFRESH_RETRY_DURATION_MS / 60000} minutes. Falling back to Puppeteer.`);
        } else {
            logger.info("No session file found. Proceeding directly to Puppeteer login.");
        }

        // Fallback: This is reached ONLY IF:
        // 1. The session file didn't exist/was invalid.
        // 2. The session file existed, but refreshing failed repeatedly for 30 minutes.
        await this._performFreshLogin();
        logger.info("Session successfully established via fresh Puppeteer login.");
    }

    /**
     * Tries to refresh the session, retrying on failure for a configured duration.
     * @returns {Promise<boolean>} True if successful, false otherwise.
     */
    private async _tryRefreshWithRetries(): Promise<boolean> {
        const startTime = Date.now();
        let attempt = 0;

        while (Date.now() - startTime < REFRESH_RETRY_DURATION_MS) {
            attempt++;
            try {
                await this._ensureValidTokens();
                return true; // Success!
            } catch (error) {
                const errorMessage = (error as Error).message;
                // Check if the error is due to an expired token, which is unrecoverable.
                // If so, we should stop retrying and proceed to Puppeteer immediately.
                if (errorMessage.includes("failed with status 401") || errorMessage.includes("failed with status 403")) {
                    logger.warn(`Refresh failed with unrecoverable auth error (e.g., expired token): ${errorMessage}. Stopping retries.`);
                    return false;
                }

                logger.warn(`Refresh attempt ${attempt} failed: ${errorMessage}. Retrying in ${REFRESH_RETRY_INTERVAL_MS / 1000}s...`);
                await timersPromises.setTimeout(REFRESH_RETRY_INTERVAL_MS);
            }
        }

        return false; // All retries failed.
    }

    public startBackgroundJobs() {
        this._refreshShortLivedTokens();
        this._manageTokenLifecycle();
    }

    private async _performFreshLogin() {
        logger.info("Performing full login via Puppeteer to get new tokens...");
        await this._extractInitialTokens();
        await this._setTokenData();
        await this.authContext.saveTokenToFile(); // Save the complete token set
    }

    private async _extractInitialTokens() {
        const tokens = await puppeteerLogin.extractTokensWithPuppeteer();
        this.authContext.updateFromLogin(tokens);
    }

    private async _ensureValidTokens() {
        await this._refreshSession();
        await this._setTokenData();
        await this.authContext.saveTokenToFile();
    }

    private async _refreshSession() {
        logger.info("Attempting to refresh session using Tango-RT...");
        const tangoRT = this.authContext.getTangoRT();
        if (!tangoRT) {
            throw new Error("Tango-RT not found in auth context. Cannot refresh session.");
        }
        const payload = authUtils.parseJwtPayload(tangoRT);
        const username = payload?.username || payload?.sessionId;
        if (!username) {
            throw new Error("Could not extract username/sessionId from Tango-RT JWT.");
        }

        const result = await authClient.refreshSession(username, tangoRT);
        const receivedNewRT = this.authContext.updateFromRefresh(result);

        if (receivedNewRT) {
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
            const refreshInterval = 5000;
            try {
                await this._setTokenData();
                await this.authContext.saveTokenToFile(); // Persist the new short-lived tokens
            } catch (error) {
                logger.error(`Failed to refresh short-lived tokens. Waiting for new Tango-ST in ${refreshInterval / 1000}s.`, { error });
            }
            await timersPromises.setTimeout(refreshInterval);
        }
    }

    private async _manageTokenLifecycle() {
        while (true) {
            const refreshInterval = 30 * 60 * 1000;
            await timersPromises.setTimeout(refreshInterval);
            await this._maintainSession();
        }
    }

    private async _maintainSession() {
        try {
            await this._ensureValidTokens();
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
