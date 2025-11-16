import { chromium } from "playwright";
import logger from "../common/logger.js";
import * as constants from "../common/constants.js";
import * as types from "../common/types.js";

export async function extractTokens(account: types.Account): Promise<types.LoginResult> {
    logger.info(`Starting Playwright login for ${account.email}`);

    const browser = await chromium.launch({
        headless: false,
        args: ["--disable-blink-features=AutomationControlled"],
    });

    const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        viewport: null,
    });

    const page = await context.newPage();

    try {
        const responsePromise = page.waitForResponse(constants.TANGO_URLS.GOOGLE_LOGIN, { timeout: 60000 });
        const popupPromise = page.waitForEvent("popup", { timeout: 30000 });

        await page.goto(constants.TANGO_URLS.HOME, { waitUntil: "domcontentloaded", timeout: 30000 });

        try {
            await page.getByTestId("join-now").click({ timeout: 10000 });
            await page.getByTestId("GOOGLE").click({ timeout: 10000 });
        } catch (ignore1) {
            logger.warn(`join-now not found for ${account.email}, trying another button...`);
            try {
                await page.getByTestId("home-page-login-register-button").click({ timeout: 10000 });
                await page.getByTestId("GOOGLE").click({ timeout: 10000 });
            } catch (ignore2) {
                logger.warn(`home-page-login-register-button not found for ${account.email}, trying again...`);
                try {
                    await page.locator('//button[.//span[contains(., "Log in / Sign up")]]').click({ timeout: 10000 });
                    await page.getByTestId("GOOGLE").click({ timeout: 10000 });
                } catch (ignore3) {
                    logger.warn(`Log in / Sign up not found for ${account.email}, trying for the last time...`);
                    await page.locator('//button[.//span[contains(., "Sign in")]]').click({ timeout: 10000 });
                    await page.getByTestId("GOOGLE").click({ timeout: 10000 });
                }
            }
        }

        const googlePopup = await popupPromise;
        logger.info(`Google popup detected for ${account.email}. Starting authentication process...`);

        const maxGoogleRetries = 3;
        for (let googleAttempt = 1; googleAttempt <= maxGoogleRetries; googleAttempt++) {
            try {
                logger.info(`Google login attempt ${googleAttempt}/${maxGoogleRetries} for ${account.email}...`);

                try {
                    await googlePopup.locator("#identifierId").fill(account.email, { timeout: 5000 });
                    logger.info(`Entered email for ${account.email}.`);
                    await googlePopup.getByRole("button", { name: "Next" }).click();
                } catch (e) {
                    logger.info(`Email input not found for ${account.email}, assuming already on password step.`);
                }

                try {
                    await googlePopup.locator('input[type="password"]').fill(account.password, { timeout: 5000 });
                    logger.info(`Entered password for ${account.email}.`);
                    await googlePopup.getByRole("button", { name: "Next" }).click();
                } catch (e) {
                    logger.info(`Password input not found for ${account.email}, assuming on consent step.`);
                }

                await googlePopup.getByRole("button", { name: "Continue" }).click({ timeout: 15000 });
                logger.info(`Clicked 'Continue' for ${account.email}. Waiting for popup to close...`);

                await googlePopup.waitForEvent("close", { timeout: 20000 });
                logger.info(`Google popup closed successfully for ${account.email}.`);
                break;
            } catch (error: any) {
                logger.error(`Google login attempt ${googleAttempt} failed for ${account.email}.`, { error: error.message });
                if (googleAttempt === maxGoogleRetries) {
                    throw new Error(`Failed to log in via Google for ${account.email} after ${maxGoogleRetries} attempts.`);
                }
                if (!googlePopup.isClosed()) {
                    await googlePopup.reload({ waitUntil: "domcontentloaded" });
                } else {
                    throw new Error(`Google popup closed unexpectedly for ${account.email}. Cannot retry.`);
                }
            }
        }

        const response = await responsePromise;
        const setCookieHeader = await response.headerValue("set-cookie");

        if (!setCookieHeader) {
            throw new Error(`Login response for ${account.email} did not contain set-cookie header.`);
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
            throw new Error(`Could not find Tango-RT and/or Tango-ST for ${account.email} in cookies.`);
        }

        logger.info(`Initial tokens successfully extracted for ${account.email}.`);
        return { tangoRT: foundRT, tangoST: foundST };
    } catch (error) {
        logger.error(`Failed to extract initial tokens via Playwright for ${account.email}.`, { error });
        await page.screenshot({ path: `${Date.now()}-${account.email}-error.png`, fullPage: true });
        throw error;
    } finally {
        if (browser) {
            await browser.close();
            logger.info(`Browser closed for ${account.email}.`);
        }
    }
}