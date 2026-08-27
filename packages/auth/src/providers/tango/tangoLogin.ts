import { chromium, Browser, Page } from "playwright";
import logger from "../../common/logger.js";
import { Account, TokenBag } from "../interfaces.js";
import * as constants from "./constants.js";

const BROWSER_ELEMENT_TIMEOUT_MS = 10_000;
const BROWSER_INPUT_TIMEOUT_MS = 5_000;
const BROWSER_BUTTON_TIMEOUT_MS = 15_000;
const BROWSER_POPUP_CLOSE_TIMEOUT_MS = 20_000;
const BROWSER_PAGE_TIMEOUT_MS = 30_000;
const BROWSER_LOGIN_FLOW_TIMEOUT_MS = 30_000;
const BROWSER_RESPONSE_TIMEOUT_MS = 60_000;

async function findAndClickLoginButton(page: Page, account: Account): Promise<void> {
    const signInButton = page
        .getByTestId("visitor-join-now")
        .or(page.getByTestId("join-now"))
        .first();
    await signInButton.click({ timeout: BROWSER_ELEMENT_TIMEOUT_MS });

    const googleButton = page.getByTestId("GOOGLE");
    await googleButton.click({ timeout: BROWSER_ELEMENT_TIMEOUT_MS });
    logger.info(`Successfully initiated Google login for ${account.email}`);
}

async function handleGoogleLogin(popup: Page, account: Account): Promise<void> {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            logger.info(`Google login attempt ${attempt}/${maxRetries} for ${account.email}...`);

            try {
                await popup.locator("#identifierId").fill(account.email, { timeout: BROWSER_INPUT_TIMEOUT_MS });
                await popup.getByRole("button", { name: "Next" }).click();
            } catch (e) {
                logger.info(`Email input not found for ${account.email}, proceeding.`);
            }

            try {
                await popup.locator('input[type="password"]').fill(account.password, { timeout: BROWSER_INPUT_TIMEOUT_MS });
                await popup.getByRole("button", { name: "Next" }).click();
            } catch (e) {
                logger.info(`Password input not found for ${account.email}, proceeding.`);
            }

            await popup.getByRole("button", { name: "Continue" }).click({ timeout: BROWSER_BUTTON_TIMEOUT_MS });
            await popup.waitForEvent("close", { timeout: BROWSER_POPUP_CLOSE_TIMEOUT_MS });
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

    const cookies = setCookieHeader.split("\n");
    const foundRT = constants.extractCookie(cookies, constants.COOKIE_NAMES.TANGO_RT_PREFIX);
    const foundST = constants.extractCookie(cookies, constants.COOKIE_NAMES.TANGO_ST_PREFIX);

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
        const responsePromise = page.waitForResponse(constants.TANGO_URLS.GOOGLE_LOGIN, { timeout: BROWSER_RESPONSE_TIMEOUT_MS });
        const popupPromise = page.waitForEvent("popup", { timeout: BROWSER_PAGE_TIMEOUT_MS });

        await page.goto(constants.TANGO_URLS.HOME, { waitUntil: "domcontentloaded", timeout: BROWSER_PAGE_TIMEOUT_MS });

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
        args: ["--disable-blink-features=AutomationControlled", "--disable-gpu", "--disable-gpu-compositing"],
    });
    try {
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("Browser login flow timed out")), BROWSER_LOGIN_FLOW_TIMEOUT_MS);
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
