// src/auth.ts
import * as timersPromises from 'timers/promises';
import puppeteer, { Browser, Page, Target, HTTPResponse } from 'puppeteer';

import * as config from './config.js';
import logger from './logger.js';
import * as utils from './utils.js';
import * as state from './state.js';
import * as requests from './requests.js';

async function extractInitialTokens() {
    const email = process.env.GOOGLE_EMAIL
    const password = process.env.GOOGLE_PASSWORD
    if (!(email && password)) {
        throw new Error("could not find process.env.GOOGLE_EMAIL. first, check .env")
    }

    logger.info(`Puppeteer is using browser executable at: ${puppeteer.executablePath()}`);
    
    let browser: Browser | undefined;

    try {
        const maxLaunchRetries = 10; // Attempt to launch up to 10 times
        const initialLaunchDelay = 2000; // Start with a 2-second delay

        for (let attempt = 1; attempt <= maxLaunchRetries; attempt++) {
            try {
                logger.info(`Attempt ${attempt}/${maxLaunchRetries}: Launching browser for automatic login...`);
                browser = await puppeteer.launch({
                    headless: false, // Keeping this as per your requirement
                    args: [
                        '--disable-blink-features=AutomationControlled',
                        '--window-size=1500,1000',
                    ],
                    defaultViewport: null
                });
                logger.info("Browser launched successfully.");
                break; // Success, exit the retry loop
            } catch (error: any) {
                // Check if it's the specific launch failure we want to retry
                if (error.message.includes('Failed to launch the browser process')) {
                    if (attempt === maxLaunchRetries) {
                        logger.error("Failed to launch browser after all retry attempts. A graphical environment (X server) is required.", { error });
                        throw error; // Give up after the last attempt
                    }

                    // Exponential backoff, capped at 5 minutes
                    const delay = Math.min(initialLaunchDelay * (2 ** (attempt - 1)), 300000); 
                    logger.warn(`Failed to launch browser (is a display available?). Retrying in ${delay / 1000} seconds...`, { originalError: error.message.split('\n')[0] });
                    await timersPromises.setTimeout(delay);
                } else {
                    // For any other unexpected error, fail immediately
                    logger.error("An unexpected error occurred while launching the browser.", { error });
                    throw error;
                }
            }
        }

        if (!browser) {
            // This safeguard ensures the browser is initialized before proceeding.
            throw new Error("Browser could not be initialized after all attempts. Please check the logs.");
        }


        const tango = await browser.newPage();

        while (true) {
            try {
                await tango.goto('https://tango.me', { waitUntil: 'networkidle2' });
                break;
            } catch (error) {
                logger.error("There is no internet, trying again in 5s", { error });
                await timersPromises.setTimeout(5000)
            }
        }
        await tango.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        );


        // Step 2: Click "Continue with Google"
        await timersPromises.setTimeout(5000);
        try {
            await tango.click('button[data-testid="GOOGLE"]');
        } catch (ignore1) {
            logger.warn(`button[data-testid="GOOGLE"] is not there, trying another button...`);
            try {
                await tango.click('button[data-testid="home-page-login-register-button"]');
                await tango.waitForSelector('button[data-testid="GOOGLE"]', { visible: true });
                await tango.click('button[data-testid="GOOGLE"]');
            } catch (ignore2) {
                logger.warn(`button[data-testid="home-page-login-register-button"] is not there, trying the last way...`);
                try {
                    const loginButton = await tango.waitForSelector('//button[.//span[contains(., "Log in / Sign up")]]');
                    await loginButton?.click();
                    await tango.waitForSelector('button[data-testid="GOOGLE"]', { visible: true });
                    await tango.click('button[data-testid="GOOGLE"]'); // throw an error here if it doesn't exist
                } catch (error) {
                    logger.error(`could not find "Log in / Sign up" or button[data-testid="GOOGLE"],`, { error })
                    throw error
                }
            }
        }

        const googlePopupTarget = await browser.waitForTarget((target: Target) => target.url().includes('accounts.google.com'));
        const googlePopup = (await googlePopupTarget.page()) as Page;

        if (!googlePopup) {
            logger.error("Could not find the Google authentication popup")
            throw new Error("Could not find the Google authentication popup.");
        }
        logger.info("Google popup detected. Starting authentication process...");

        const maxGoogleRetries = 3;
        for (let googleAttempt = 1; googleAttempt <= maxGoogleRetries; googleAttempt++) {
            try {
                logger.info(`Google login attempt ${googleAttempt}/${maxGoogleRetries}...`);

                try {
                    await googlePopup.waitForSelector('#identifierId', { visible: true, timeout: 5000 });
                    logger.info("Email input found. Entering email.");
                    await googlePopup.type('#identifierId', email);
                    await googlePopup.locator('::-p-aria(Next)').click();
                    await timersPromises.setTimeout(3000); // Wait for transition to password page
                } catch (e) {
                    logger.info("Email input not found, assuming we are already on the password or continue step.");
                }

                try {
                    await googlePopup.waitForSelector('#password input[type="password"]', { visible: true, timeout: 5000 });
                    logger.info("Password input found. Entering password.");
                    await googlePopup.type('#password input[type="password"]', password);
                    await googlePopup.locator('::-p-aria(Next)').click();
                    await timersPromises.setTimeout(3000); // Wait for transition to consent page
                } catch (e) {
                    logger.info("Password input not found, assuming we are on the consent/continue step.");
                }

                // --- Step 3: Handle "Continue" / Consent Screen (this should always be the final step) ---
                await googlePopup.waitForSelector('::-p-aria(Continue)', { visible: true, timeout: 15000 });
                logger.info("Continue button found. Clicking it.");
                await googlePopup.locator('::-p-aria(Continue)').click();

                // --- Step 4: Verify Success (Popup Closes) or Detect Failure (Crash/Hang) ---
                logger.info("Clicked 'Continue'. Waiting for popup to close...");

                await Promise.race([
                    new Promise<void>(resolve => googlePopup.once('close', () => resolve())),
                    new Promise<void>((_, reject) => googlePopup.once('error', (err: Error) => reject(new Error(`Google popup crashed: ${err.message}`)))),
                    timersPromises.setTimeout(20000).then(() => Promise.reject(new Error("Timeout: Google popup did not close after 20 seconds.")))
                ]);

                logger.info("Google popup closed successfully. Authentication complete.");
                break; // Success! Exit the retry loop.

            } catch (error: any) {
                logger.error(`Google login attempt ${googleAttempt} failed.`, { error });

                if (googleAttempt === maxGoogleRetries) {
                    throw new Error(`Failed to log in via Google after ${maxGoogleRetries} attempts.`);
                }

                if (!googlePopup.isClosed()) {
                    logger.warn("Popup is still open. Reloading it for the next attempt...");
                    await googlePopup.reload({ waitUntil: 'networkidle2' });
                } else {
                    throw new Error("Google popup crashed and closed unexpectedly. Cannot retry.");
                }
            }
        }

        logger.info("Waiting to intercept the session response from Tango's API...");
        await new Promise<void>((resolve, reject) => {
            tango.on('response', async (response: HTTPResponse) => {
                if (response.url() === "https://gateway.tango.me/google-login/auth-code/v1/login") {
                    let rtFound = false;
                    let stFound = false;
                    const headers = response.headers();
                    const setCookieHeader = headers['set-cookie']; // The 'set-cookie' header can appear multiple times, puppeteer joins them with a newline
                    if (setCookieHeader) {
                        const cookies = setCookieHeader.split('\n');
                        for (const cookie of cookies) {
                            if (cookie.trim().startsWith("Tango-RT=")) {
                                const tangoRT = cookie.split(';')[0].substring("Tango-RT=".length);
                                logger.info(`Found Tango-RT via Set-Cookie header.`);
                                state.setTangoRT(tangoRT);
                                rtFound = true
                                await utils.saveTokenToFile(); // Save the refresh token to a file
                            }
                            if (cookie.trim().startsWith("Tango-ST=")) {
                                const tangoST = cookie.split(';')[0].substring("Tango-ST=".length);
                                logger.info(`Found Tango-ST via Set-Cookie header.`);
                                state.setTangoST(tangoST);
                                stFound = true
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
        // Log the final error that caused the process to fail
        logger.error("Failed to extract initial tokens via Puppeteer.", { error });
        throw error; // Re-throw the error to be handled by the initialAuth function
    } finally {
        // This block ensures the browser is closed regardless of success or failure
        if (browser) {
            logger.info("Closing browser...");
            await browser.close();
        }
    }
}

async function setTokenData() {
    const tokenDataResponse = await requests.getTokenDataResponse();
    if (!tokenDataResponse) {
        throw new Error(`Failed to fetch token data. The request function has logged the details.`);
    }

    try {
        // 1. Get all cookies as an array
        const allCookies = tokenDataResponse.headers.getSetCookie();

        // 2. Prepare variables to store the values
        let tt, ttu, tte;

        // 3. Iterate over the array to find the cookies you want
        for (const cookieString of allCookies) {
            const trimmedCookie = cookieString.trim();

            if (trimmedCookie.startsWith("tt=")) {
                // 'tt=value_for_tt; Path=/; HttpOnly'
                tt = trimmedCookie.split(";")[0]; // 'tt=value_for_tt'
            } else if (trimmedCookie.startsWith("ttu=")) {
                ttu = trimmedCookie.split(";")[0]; // 'ttu=value_for_ttu'
            } else if (trimmedCookie.startsWith("tte=")) {
                tte = trimmedCookie.split(";")[0]; // 'tte=value_for_tte'
            }
        }

        // 4. Now that you have the full 'key=value' strings, set your state
        if (tt && ttu && tte) {
            // The value is the second part after splitting by '='
            const ttValue = tt.split('=')[1];
            state.setTt(ttValue);

            const ttuValue = ttu.split('=')[1];
            state.setTtu(ttuValue);

            const tteValue = tte.split('=')[1];
            state.setTte(tteValue);

            utils.updateStatusFile();
        } else {
            logger.error("Could not find all required cookies (tt, ttu, tte).");
            logger.info({ tt, ttu, tte });
            throw new Error("Missing required cookies from tokenData response.");
        }

    } catch (error) {
        logger.error('Failed to process cookies:', { error });
        throw error
    }
}

/**
 * A lightweight JWT payload parser that does not verify the signature.
 * @param token The JWT string.
 * @returns The parsed payload object, or null if parsing fails.
 */
function parseJwtPayload(token: string): { [key: string]: any } | null {
    try {
        const base64Url = token.split('.')[1];
        if (!base64Url) return null;
        // Node's Buffer.from(string, 'base64') handles URL-safe base64 characters ('-' and '_') correctly.
        const jsonPayload = Buffer.from(base64Url, 'base64').toString();
        return JSON.parse(jsonPayload);
    } catch (error) {
        logger.error("Failed to parse JWT payload", { token, error });
        return null;
    }
}

/**
 * Uses the long-lived Tango-RT to refresh the medium-lived Tango-ST.
 * This also returns a new Tango-RT, which we save.
 */
async function refreshSession() {
    logger.info("Attempting to refresh session using Tango-RT...");

    const tangoRT = state.getTangoRT();
    if (!tangoRT) {
        throw new Error("Tango-RT not found in state. Cannot refresh session.");
    }

    const payload = parseJwtPayload(tangoRT);
    const username = payload?.username || payload?.sessionId;

    if (!username) {
        throw new Error("Could not extract username/sessionId from Tango-RT JWT.");
    }

    const response = await requests.postRefreshSession(username);
    if (!response) {
        throw new Error(`Failed to refresh session. The request function has logged the details. Tango-RT might be expired.`);
    }

    const allCookies = response.headers.getSetCookie();
    let newStFound = false;
    let newRtFound = false;
    for (const cookieString of allCookies) {
        const trimmedCookie = cookieString.trim();
        if (trimmedCookie.startsWith("Tango-ST=")) {
            const newTangoST = trimmedCookie.split(';')[0].substring("Tango-ST=".length);
            state.setTangoST(newTangoST);
            newStFound = true;
        } else if (trimmedCookie.startsWith("Tango-RT=")) {
            const newTangoRT = trimmedCookie.split(';')[0].substring("Tango-RT=".length);
            state.setTangoRT(newTangoRT);
            await utils.saveTokenToFile(); // Save the new refresh token immediately
            newRtFound = true;
        }
    }

    if (!newStFound) {
        throw new Error("Refresh endpoint did not return a new Tango-ST cookie.");
    }

    if (newRtFound) {
        logger.info("Successfully refreshed Tango-ST and received a new Tango-RT.");
    } else {
        // This case is unlikely based on observed behavior, but good to log.
        logger.warn("Successfully refreshed Tango-ST, but a new Tango-RT was not provided in the response.");
    }
}


/**
 * Performs the initial authentication, prioritizing stored tokens before falling back to Puppeteer.
 * This function will now retry indefinitely on failure, ensuring the app doesn't crash on startup
 * due to network issues.
 */
export async function initialAuth() {
    let success = false;
    while (!success) {
        try {
            const loaded = await utils.loadTokenFromFile();
            if (loaded) {
                logger.info("Tango-RT loaded from file. Attempting to refresh session...");
                try {
                    await refreshSession(); // This gets new ST and a new RT
                    await setTokenData();   // This uses the new ST to get session tokens
                    logger.info("Session successfully refreshed using token from file.");
                    success = true; // Mark as successful to exit the while loop
                    continue; // Continue to exit the current iteration
                } catch (error) {
                    logger.warn("Failed to refresh session using token from file. Falling back to full Puppeteer login.", { error: (error as Error).message });
                    // Let it fall through to the full login within the same loop iteration
                }
            }

            // If load/refresh failed, perform the full login.
            logger.info("Performing full login via Puppeteer to get new tokens...");
            await extractInitialTokens();
            await setTokenData();
            success = true; // Mark as successful to exit the while loop

        } catch (error) {
            const errorMessage = (error as Error).message;
            logger.error(`Initial authentication failed: ${errorMessage}. Retrying in 30 seconds...`);
            await timersPromises.setTimeout(30000); // Wait 30 seconds before retrying
        }
    }
}

/**
 * A continuous loop to refresh the short-lived tt, ttu, and tte tokens.
 * This runs in the background. If it fails, it simply logs the error and waits for the
 * long-lived token refresh loop to fix the underlying Tango-ST issue.
 */
export async function refreshShortLivedTokens() {
    while (true) {
        try {
            await setTokenData();
        } catch (error) {
            logger.error("Failed to refresh short-lived tokens. Waiting for new Tango-ST.", { error });
            // Don't re-throw; just wait for the next interval. The long-lived refresh will handle fatal auth errors.
        }
        await timersPromises.setTimeout(config.getConfig().intervals.shortTokenRefresh);
    }
}

/**
 * A continuous loop to refresh the Tango-ST and Tango-RT tokens.
 * This runs in the background on a much longer interval (e.g., every 30 minutes).
 */
export async function manageTokenLifecycle() {
    while (true) {
        const refreshInterval = config.getConfig().intervals.longTokenRefreshMinutes * 60 * 1000;
        await timersPromises.setTimeout(refreshInterval);
        try {
            // 1. Attempt the efficient API-based refresh.
            await refreshSession();
            // 2. After getting a new ST, immediately get fresh session tokens.
            await setTokenData();

        } catch (error) {
            // 3. If API refresh fails, the refresh token (Tango-RT) is likely expired.
            // Fall back to the full Puppeteer login to get new ones.
            logger.error("Lightweight session refresh failed. Falling back to full Puppeteer re-authentication.", { error });
            try {
                await extractInitialTokens();
                await setTokenData();
                logger.info("Successfully re-authenticated via Puppeteer and refreshed all tokens.");
            } catch (fatalError) {
                logger.error("CRITICAL: The fallback Puppeteer re-authentication also failed. The application might not recover.", { fatalError });
                // We continue the loop to try again after the next interval.
            }
        }
    }
}