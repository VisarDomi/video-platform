// src/tokenManager.ts
import * as timersPromises from "timers/promises";
import puppeteer, { Browser, Page, Target, HTTPResponse } from "puppeteer";
import * as config from "./config.js";
import logger from "./logger.js";
import * as requests from "./requests.js";
import { AuthContext } from "./authContext.js";

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
        const email = process.env.GOOGLE_EMAIL;
        const password = process.env.GOOGLE_PASSWORD;
        if (!(email && password)) {
            throw new Error("could not find process.env.GOOGLE_EMAIL. first, check .env");
        }
        logger.info(`Puppeteer is using browser executable at: ${puppeteer.executablePath()}`);
        let browser: Browser | undefined;
        try {
            const maxLaunchRetries = 10;
            const initialLaunchDelay = 2000;
            for (let attempt = 1; attempt <= maxLaunchRetries; attempt++) {
                try {
                    logger.info(`Attempt ${attempt}/${maxLaunchRetries}: Launching browser for automatic login...`);
                    browser = await puppeteer.launch({
                        headless: false,
                        args: ["--disable-blink-features=AutomationControlled", "--window-size=1500,1000"],
                        defaultViewport: null,
                    });
                    logger.info("Browser launched successfully.");
                    break;
                } catch (error: any) {
                    if (error.message.includes("Failed to launch the browser process")) {
                        if (attempt === maxLaunchRetries) {
                            logger.error("Failed to launch browser after all retry attempts.", { error });
                            throw error;
                        }
                        const delay = Math.min(initialLaunchDelay * 2 ** (attempt - 1), 300000);
                        logger.warn(`Failed to launch browser. Retrying in ${delay / 1000} seconds...`, { originalError: error.message.split("\n")[0] });
                        await timersPromises.setTimeout(delay);
                    } else {
                        logger.error("An unexpected error occurred while launching the browser.", { error });
                        throw error;
                    }
                }
            }
            if (!browser) {
                throw new Error("Browser could not be initialized after all attempts. Please check the logs.");
            }
            const tango = await browser.newPage();
            // This is a simplified placeholder for your full puppeteer logic
            await tango.goto("https://tango.me", { waitUntil: "networkidle2" });
            
            await new Promise<void>((resolve, reject) => {
                tango.on("response", async (response: HTTPResponse) => {
                    if (response.url() === "https://gateway.tango.me/google-login/auth-code/v1/login") {
                        let rtFound = false;
                        let stFound = false;
                        const headers = response.headers();
                        const setCookieHeader = headers["set-cookie"];
                        if (setCookieHeader) {
                            const cookies = setCookieHeader.split("\n");
                            for (const cookie of cookies) {
                                if (cookie.trim().startsWith("Tango-RT=")) {
                                    const tangoRT = cookie.split(";")[0].substring("Tango-RT=".length);
                                    this.authContext.setTangoRT(tangoRT);
                                    await this.authContext.saveTokenToFile();
                                    rtFound = true;
                                }
                                if (cookie.trim().startsWith("Tango-ST=")) {
                                    const tangoST = cookie.split(";")[0].substring("Tango-ST=".length);
                                    this.authContext.setTangoST(tangoST);
                                    stFound = true;
                                }
                            }
                        }
                        if (rtFound && stFound) {
                            resolve();
                        }
                    }
                });
                timersPromises.setTimeout(60000).then(() => reject(new Error("Timeout: Did not intercept a response with Tango-RT and Tango-ST within 60 seconds.")));
            });
            logger.info("Initial refresh token found.");
        } catch (error) {
            logger.error("Failed to extract initial tokens via Puppeteer.", { error });
            throw error;
        } finally {
            if (browser) {
                logger.info("Closing browser...");
                await browser.close();
            }
        }
    }

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
        const response = await requests.postRefreshSession(username, tangoRT);
        if (!response) {
            throw new Error(`Failed to refresh session. The request function has logged the details. Tango-RT might be expired.`);
        }
        const allCookies = response.headers.getSetCookie();
        let newStFound = false;
        let newRtFound = false;
        for (const cookieString of allCookies) {
            const trimmedCookie = cookieString.trim();
            if (trimmedCookie.startsWith("Tango-ST=")) {
                const newTangoST = trimmedCookie.split(";")[0].substring("Tango-ST=".length);
                this.authContext.setTangoST(newTangoST);
                newStFound = true;
            } else if (trimmedCookie.startsWith("Tango-RT=")) {
                const newTangoRT = trimmedCookie.split(";")[0].substring("Tango-RT=".length);
                this.authContext.setTangoRT(newTangoRT);
                await this.authContext.saveTokenToFile();
                newRtFound = true;
            }
        }
        if (!newStFound) {
            throw new Error("Refresh endpoint did not return a new Tango-ST cookie.");
        }
        if (newRtFound) {
            logger.info("Successfully refreshed Tango-ST and received a new Tango-RT.");
        } else {
            logger.warn("Successfully refreshed Tango-ST, but a new Tango-RT was not provided in the response.");
        }
    }

    private async setTokenData() {
        const tokenDataResponse = await requests.getTokenDataResponse(this.authContext);
        if (!tokenDataResponse) {
            throw new Error(`Failed to fetch token data. The request function has logged the details.`);
        }
        try {
            const allCookies = tokenDataResponse.headers.getSetCookie();
            let tt, ttu, tte;
            for (const cookieString of allCookies) {
                const trimmedCookie = cookieString.trim();
                if (trimmedCookie.startsWith("tt=")) tt = trimmedCookie.split(";")[0];
                if (trimmedCookie.startsWith("ttu=")) ttu = trimmedCookie.split(";")[0];
                if (trimmedCookie.startsWith("tte=")) tte = trimmedCookie.split(";")[0];
            }
            if (tt && ttu && tte) {
                this.authContext.setTt(tt.split("=")[1]);
                this.authContext.setTtu(ttu.split("=")[1]);
                this.authContext.setTte(tte.split("=")[1]);
                // THE BUG WAS HERE: The old call to `utils.updateStatusFile()` is now removed.
            } else {
                logger.error("Could not find all required cookies (tt, ttu, tte).");
                logger.info({ tt, ttu, tte });
                throw new Error("Missing required cookies from tokenData response.");
            }
        } catch (error) {
            logger.error("Failed to process cookies:", { error });
            throw error;
        }
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