// src/auth/puppeteerLogin.ts
import puppeteer, { Browser, HTTPResponse, Page, Target } from "puppeteer";
import * as timersPromises from "timers/promises";

import logger from "../common/logger.js";
import * as constants from "../common/constants.js";
import * as types from "../common/types.js";

/**
 * Launches Puppeteer to perform a full browser login and intercept the initial tokens.
 */
export async function extractTokens(): Promise<types.LoginResult> {
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

        const page = await browser.newPage();

        // This promise will resolve when the tokens are intercepted after a successful login.
        const tokenPromise = new Promise<types.LoginResult>((resolve, reject) => {
            page.on("response", async (response: HTTPResponse) => {
                if (response.url() === constants.TANGO_URLS.GOOGLE_LOGIN) {
                    let foundRT: string | null = null;
                    let foundST: string | null = null;
                    const headers = response.headers();
                    const setCookieHeader = headers["set-cookie"];
                    if (setCookieHeader) {
                        const cookies = setCookieHeader.split("\n");
                        for (const cookie of cookies) {
                            if (cookie.trim().startsWith(constants.COOKIE_NAMES.TANGO_RT_PREFIX)) {
                                foundRT = cookie.split(";")[0].substring(constants.COOKIE_NAMES.TANGO_RT_PREFIX.length);
                            }
                            if (cookie.trim().startsWith(constants.COOKIE_NAMES.TANGO_ST_PREFIX)) {
                                foundST = cookie.split(";")[0].substring(constants.COOKIE_NAMES.TANGO_ST_PREFIX.length);
                            }
                        }
                    }
                    if (foundRT && foundST) {
                        resolve({ tangoRT: foundRT, tangoST: foundST });
                    }
                }
            });

            // Set a generous timeout for the entire login operation.
            timersPromises.setTimeout(120000).then(() => reject(new Error("Timeout: Did not complete Google login and intercept tokens within 120 seconds.")));
        });

        await page.goto(constants.TANGO_URLS.HOME, { waitUntil: "networkidle2" });
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");

        // Step 1: Click "Continue with Google" button, trying multiple selectors for robustness.
        await timersPromises.setTimeout(5000); // Wait for page scripts to load
        try {
            await page.click('button[data-testid="GOOGLE"]');
        } catch (ignore1) {
            logger.warn(`button[data-testid="GOOGLE"] is not there, trying another button...`);
            try {
                await page.click('button[data-testid="home-page-login-register-button"]');
                await page.waitForSelector('button[data-testid="GOOGLE"]', { visible: true });
                await page.click('button[data-testid="GOOGLE"]');
            } catch (ignore2) {
                logger.warn(`button[data-testid="home-page-login-register-button"] is not there, trying the last way...`);
                try {
                    const loginButton = await page.waitForSelector('//button[.//span[contains(., "Log in / Sign up")]]');
                    await loginButton?.click();
                    await page.waitForSelector('button[data-testid="GOOGLE"]', { visible: true });
                    await page.click('button[data-testid="GOOGLE"]');
                } catch (error) {
                    logger.error(`could not find "Log in / Sign up" or button[data-testid="GOOGLE"],`, { error });
                    throw error;
                }
            }
        }

        // Step 2: Handle the Google authentication popup.
        const googlePopupTarget = await browser.waitForTarget((target: Target) => target.url().includes("accounts.google.com"));
        const googlePopup = (await googlePopupTarget.page()) as Page;

        if (!googlePopup) {
            throw new Error("Could not find the Google authentication popup.");
        }
        logger.info("Google popup detected. Starting authentication process...");

        const maxGoogleRetries = 3;
        for (let googleAttempt = 1; googleAttempt <= maxGoogleRetries; googleAttempt++) {
            try {
                logger.info(`Google login attempt ${googleAttempt}/${maxGoogleRetries}...`);

                try {
                    await googlePopup.waitForSelector("#identifierId", { visible: true, timeout: 5000 });
                    logger.info("Email input found. Entering email.");
                    await googlePopup.type("#identifierId", email);
                    await googlePopup.locator("::-p-aria(Next)").click();
                    await timersPromises.setTimeout(3000); // Wait for transition
                } catch (e) {
                    logger.info("Email input not found, assuming we are already on the password or continue step.");
                }

                try {
                    await googlePopup.waitForSelector('input[type="password"]', { visible: true, timeout: 5000 });
                    logger.info("Password input found. Entering password.");
                    await googlePopup.type('input[type="password"]', password);
                    await googlePopup.locator("::-p-aria(Next)").click();
                    await timersPromises.setTimeout(3000); // Wait for transition
                } catch (e) {
                    logger.info("Password input not found, assuming we are on the consent/continue step.");
                }

                await googlePopup.waitForSelector("::-p-aria(Continue)", { visible: true, timeout: 15000 });
                logger.info("Continue button found. Clicking it.");
                await googlePopup.locator("::-p-aria(Continue)").click();

                logger.info("Clicked 'Continue'. Waiting for popup to close...");

                await Promise.race([
                    new Promise<void>((resolve) => googlePopup.once("close", () => resolve())),
                    new Promise<void>((_, reject) => googlePopup.once("error", (err: Error) => reject(new Error(`Google popup crashed: ${err.message}`)))),
                    timersPromises.setTimeout(20000).then(() => Promise.reject(new Error("Timeout: Google popup did not close after 20 seconds."))),
                ]);

                logger.info("Google popup closed successfully. Authentication complete.");
                break; // Success!
            } catch (error: any) {
                logger.error(`Google login attempt ${googleAttempt} failed.`, { error });

                if (googleAttempt === maxGoogleRetries) {
                    throw new Error(`Failed to log in via Google after ${maxGoogleRetries} attempts.`);
                }

                if (!googlePopup.isClosed()) {
                    logger.warn("Popup is still open. Reloading it for the next attempt...");
                    await googlePopup.reload({ waitUntil: "networkidle2" });
                } else {
                    throw new Error("Google popup crashed and closed unexpectedly. Cannot retry.");
                }
            }
        }

        const tokens = await tokenPromise;
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
