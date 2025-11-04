// src/browser/playwrightLogin.ts
import { chromium } from "playwright";
import logger from "../common/logger.js";
import * as constants from "../common/constants.js";
import * as types from "../common/types.js";

/**
 * Launches Playwright to perform a full browser login and intercept the initial tokens.
 */
export async function extractTokens(): Promise<types.LoginResult> {
    const email = process.env.GOOGLE_EMAIL;
    const password = process.env.GOOGLE_PASSWORD;
    if (!(email && password)) {
        throw new Error("Could not find GOOGLE_EMAIL and/or GOOGLE_PASSWORD in environment variables. First, check .env");
    }

    logger.info(`playwright is using browser executable at: ${chromium.executablePath()}`);
    const browser = await chromium.launch({
        headless: false,
        args: ["--disable-blink-features=AutomationControlled"],
    });

    const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        viewport: null, // This makes the viewport adapt to the window size, like in your puppeteer script
    });

    const page = await context.newPage();

    try {
        // --- Step 1: Set up listeners BEFORE taking actions ---
        // Playwright can wait for a specific response. This is cleaner than wrapping listeners in a manual Promise.
        const responsePromise = page.waitForResponse(constants.TANGO_URLS.GOOGLE_LOGIN, { timeout: 60000 });

        // Similarly, we can wait for a popup window to be created.
        const popupPromise = page.waitForEvent("popup", { timeout: 30000 });

        // --- Step 2: Navigate and initiate login ---
        await page.goto(constants.TANGO_URLS.HOME, { waitUntil: "domcontentloaded", timeout: 30000 });

        // --- Step 3: Click the Google login button with fallbacks ---
        // Playwright's locators auto-wait, so the 5-second arbitrary wait from the Puppeteer script is no longer needed.
        try {
            await page.getByTestId("join-now").click({ timeout: 10000 });
            await page.getByTestId("GOOGLE").click({ timeout: 10000 });
        } catch (ignore1) {
            logger.warn(`join-now is not there, trying another button...`);
            try {
                await page.getByTestId("home-page-login-register-button").click({ timeout: 10000 });
                await page.getByTestId("GOOGLE").click({ timeout: 10000 });
            } catch (ignore2) {
                logger.warn(`home-page-login-register-button not found, trying again...`);
                try {
                    await page.locator('//button[.//span[contains(., "Log in / Sign up")]]').click({ timeout: 10000 });
                    await page.getByTestId("GOOGLE").click({ timeout: 10000 });
                } catch (ignore3) {
                    logger.warn(`Log in / Sign up not found, trying for the last time...`);
                    await page.locator('//button[.//span[contains(., "Sign in")]]').click({ timeout: 10000 });
                    await page.getByTestId("GOOGLE").click({ timeout: 10000 });
                }
            }
        }

        // --- Step 4: Handle the Google Authentication Popup ---
        const googlePopup = await popupPromise;
        logger.info("Google popup detected. Starting authentication process...");

        const maxGoogleRetries = 3;
        for (let googleAttempt = 1; googleAttempt <= maxGoogleRetries; googleAttempt++) {
            try {
                logger.info(`Google login attempt ${googleAttempt}/${maxGoogleRetries}...`);

                // Email Step
                try {
                    // fill() is generally faster and more reliable for inputs than type().
                    // We also use a more readable locator for the 'Next' button.
                    await googlePopup.locator("#identifierId").fill(email, { timeout: 5000 });
                    logger.info("Email input found. Entering email.");
                    await googlePopup.getByRole("button", { name: "Next" }).click();
                } catch (e) {
                    logger.info("Email input not found, assuming we are already on the password or continue step.");
                }

                // Password Step
                try {
                    await googlePopup.locator('input[type="password"]').fill(password, { timeout: 5000 });
                    logger.info("Password input found. Entering password.");
                    await googlePopup.getByRole("button", { name: "Next" }).click();
                } catch (e) {
                    logger.info("Password input not found, assuming we are on the consent/continue step.");
                }

                // Continue/Consent Step
                await googlePopup.getByRole("button", { name: "Continue" }).click({ timeout: 15000 });
                logger.info("Continue button found. Clicking it.");
                logger.info("Clicked 'Continue'. Waiting for popup to close...");

                // Wait for the popup to close itself, which signals a successful login.
                await googlePopup.waitForEvent("close", { timeout: 20000 });
                logger.info("Google popup closed successfully. Authentication complete.");
                break; // Success!
            } catch (error: any) {
                logger.error(`Google login attempt ${googleAttempt} failed.`, { error: error.message });
                if (googleAttempt === maxGoogleRetries) {
                    throw new Error(`Failed to log in via Google after ${maxGoogleRetries} attempts.`);
                }
                if (!googlePopup.isClosed()) {
                    logger.warn("Popup is still open. Reloading it for the next attempt...");
                    await googlePopup.reload({ waitUntil: "domcontentloaded" });
                } else {
                    throw new Error("Google popup crashed and closed unexpectedly. Cannot retry.");
                }
            }
        }

        // --- Step 5: Process the response and extract tokens ---
        const response = await responsePromise;
        const setCookieHeader = await response.headerValue("set-cookie");

        if (!setCookieHeader) {
            throw new Error("Login response did not contain set-cookie header.");
        }

        let foundRT: string | null = null;
        let foundST: string | null = null;
        const cookies = setCookieHeader.split("\n");
        for (const cookie of cookies) {
            if (cookie.trim().startsWith(constants.COOKIE_NAMES.TANGO_RT_PREFIX)) {
                foundRT = cookie.split(";")[0].substring(constants.COOKIE_NAMES.TANGO_RT_PREFIX.length);
            }
            if (cookie.trim().startsWith(constants.COOKIE_NAMES.TANGO_ST_PREFIX)) {
                foundST = cookie.split(";")[0].substring(constants.COOKIE_NAMES.TANGO_ST_PREFIX.length);
            }
        }

        if (!foundRT || !foundST) {
            throw new Error("Could not find Tango-RT and/or Tango-ST in login response cookies.");
        }

        logger.info("Initial tokens found via Playwright.");
        return { tangoRT: foundRT, tangoST: foundST };
    } catch (error) {
        logger.error("Failed to extract initial tokens via Playwright.", { error });
        // Taking a screenshot on failure is a powerful debugging tool.
        await page.screenshot({ path: `${Date.now()} error.png`, fullPage: true });
        throw error;
    } finally {
        if (browser) {
            logger.info("Closing browser...");
            await browser.close();
        }
    }
}
