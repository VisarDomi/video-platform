import { chromium, Browser, Page } from "playwright";
import logger from "../../common/logger.js";
import { Account, TokenBag } from "../interfaces.js";
import * as constants from "./constants.js";

async function findAndClickLoginButton(page: Page, account: Account): Promise<void> {
    const loginButtonSelectors = [
        { testId: "join-now" },
        { testId: "home-page-login-register-button" },
        { xpath: '//button[.//span[contains(., "Log in / Sign up")]]' },
        { xpath: '//button[.//span[contains(., "Sign in")]]' },
    ];

    for (const selector of loginButtonSelectors) {
        try {
            if (selector.testId) {
                await page.getByTestId(selector.testId).click({ timeout: 10000 });
            } else if (selector.xpath) {
                await page.locator(selector.xpath).click({ timeout: 10000 });
            }
            await page.getByTestId("GOOGLE").click({ timeout: 10000 });
            logger.info(`Successfully initiated Google login for ${account.email}`);
            return;
        } catch (error) {
            const selectorIdentifier = selector.testId ? `TestId(${selector.testId})` : `XPath(${selector.xpath})`;
            logger.warn(`Selector ${selectorIdentifier} failed for ${account.email}, trying next...`);
        }
    }

    throw new Error(`All known login button selectors failed for ${account.email}.`);
}

async function handleGoogleLogin(popup: Page, account: Account): Promise<void> {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            logger.info(`Google login attempt ${attempt}/${maxRetries} for ${account.email}...`);

            try {
                await popup.locator("#identifierId").fill(account.email, { timeout: 5000 });
                await popup.getByRole("button", { name: "Next" }).click();
            } catch (e) {
                logger.info(`Email input not found for ${account.email}, proceeding.`);
            }

            try {
                await popup.locator('input[type="password"]').fill(account.password, { timeout: 5000 });
                await popup.getByRole("button", { name: "Next" }).click();
            } catch (e) {
                logger.info(`Password input not found for ${account.email}, proceeding.`);
            }

            await popup.getByRole("button", { name: "Continue" }).click({ timeout: 15000 });
            await popup.waitForEvent("close", { timeout: 20000 });
            logger.info(`Google login successful for ${account.email}.`);
            return;
        } catch (error: any) {
            logger.error(`Google login attempt ${attempt} failed for ${account.email}.`, { error: error.message });
            if (attempt === maxRetries) {
                throw new Error(`Failed all Google login attempts for ${account.email}.`);
            }
            if (popup.isClosed()) {
                throw new Error(`Google popup closed unexpectedly for ${account.email}. Cannot retry.`);
            }
            await popup.reload({ waitUntil: "domcontentloaded" });
        }
    }
}

async function extractLoginTokensFromResponse(response: any, accountEmail: string): Promise<TokenBag> {
    const setCookieHeader = await response.headerValue("set-cookie");
    if (!setCookieHeader) {
        throw new Error(`Login response for ${accountEmail} did not contain set-cookie header.`);
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
        throw new Error(`Could not find Tango-RT and/or Tango-ST for ${accountEmail} in cookies.`);
    }

    return { refreshToken: foundRT, sessionToken: foundST, extras: {} };
}

async function runLoginFlow(browser: Browser, account: Account): Promise<TokenBag> {
    const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        viewport: null,
    });
    const page = await context.newPage();

    try {
        const responsePromise = page.waitForResponse(constants.TANGO_URLS.GOOGLE_LOGIN, { timeout: 60000 });
        const popupPromise = page.waitForEvent("popup", { timeout: 30000 });

        await page.goto(constants.TANGO_URLS.HOME, { waitUntil: "domcontentloaded", timeout: 30000 });

        await findAndClickLoginButton(page, account);
        const googlePopup = await popupPromise;
        await handleGoogleLogin(googlePopup, account);

        const response = await responsePromise;
        const tokens = await extractLoginTokensFromResponse(response, account.email);

        logger.info(`Initial tokens successfully extracted for ${account.email}.`);
        return tokens;
    } catch (error) {
        if (!page.isClosed()) {
            await page.screenshot({ path: `${Date.now()}-${account.email}-error.png`, fullPage: true });
        }
        throw error;
    }
}

export async function extractTokens(account: Account): Promise<TokenBag | null> {
    logger.info(`Acquiring browser for ${account.email}`);
    let browser: Browser;
    browser = await chromium.launch({
        headless: false,
        args: ["--disable-blink-features=AutomationControlled"],
    });
    try {
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("Browser login flow exceeded 30 seconds limit")), 30000);
        });

        return await Promise.race([
            runLoginFlow(browser, account),
            timeoutPromise
        ]);
    } catch (ignoredError) {
        return null;
    } finally {
        await browser.close();
        logger.info(`Browser released for ${account.email}.`);
    }
}
