// src/auth/puppeteerLogin.ts
import puppeteer, { Browser, HTTPResponse } from "puppeteer";
import * as timersPromises from "timers/promises";
import logger from "../logger.js";

interface InitialTokens {
    tangoRT: string;
    tangoST: string;
}

/**
 * Launches Puppeteer to perform a full browser login and intercept the initial tokens.
 * This is a self-contained, single-purpose function.
 * @returns A promise that resolves with the extracted Tango-RT and Tango-ST tokens.
 */
export async function extractTokensWithPuppeteer(): Promise<InitialTokens> {
    const email = process.env.GOOGLE_EMAIL;
    const password = process.env.GOOGLE_PASSWORD;
    if (!(email && password)) {
        throw new Error("Could not find process.env.GOOGLE_EMAIL. First, check .env");
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
        await tango.goto("https://tango.me", { waitUntil: "networkidle2" });
        
        const tokens = await new Promise<InitialTokens>((resolve, reject) => {
            tango.on("response", async (response: HTTPResponse) => {
                if (response.url() === "https://gateway.tango.me/google-login/auth-code/v1/login") {
                    let foundRT: string | null = null;
                    let foundST: string | null = null;
                    const headers = response.headers();
                    const setCookieHeader = headers["set-cookie"];
                    if (setCookieHeader) {
                        const cookies = setCookieHeader.split("\n");
                        for (const cookie of cookies) {
                            if (cookie.trim().startsWith("Tango-RT=")) {
                                foundRT = cookie.split(";")[0].substring("Tango-RT=".length);
                            }
                            if (cookie.trim().startsWith("Tango-ST=")) {
                                foundST = cookie.split(";")[0].substring("Tango-ST=".length);
                            }
                        }
                    }
                    if (foundRT && foundST) {
                        resolve({ tangoRT: foundRT, tangoST: foundST });
                    }
                }
            });
            timersPromises.setTimeout(60000).then(() => reject(new Error("Timeout: Did not intercept a response with Tango-RT and Tango-ST within 60 seconds.")));
        });

        logger.info("Initial refresh token found via Puppeteer.");
        return tokens;

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