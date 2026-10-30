import { chromium, Browser, Page } from "playwright";
import logger from "../../common/logger.js";
import { Account, TokenBag, BrowserLoginNeedsAttentionError } from "../interfaces.js";
import { createHash } from "node:crypto";
import * as constants from "./constants.js";
import { mkdir, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const BROWSER_ELEMENT_TIMEOUT_MS = 10_000;
const BROWSER_INPUT_TIMEOUT_MS = 5_000;
const BROWSER_BUTTON_TIMEOUT_MS = 15_000;
const BROWSER_POPUP_CLOSE_TIMEOUT_MS = 20_000;
const BROWSER_PAGE_TIMEOUT_MS = 30_000;
const BROWSER_LOGIN_FLOW_TIMEOUT_MS = 105_000;
const BROWSER_RESPONSE_TIMEOUT_MS = 60_000;

export function isTangoLoginResponse(url: string, status: number): boolean {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "https:" && (parsed.hostname === "tango.me" || parsed.hostname.endsWith(".tango.me"))
            && parsed.pathname.endsWith("/google-login/auth-code/v1/login") && status >= 200 && status < 300;
    } catch { return false; }
}

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
    const maxRetries = 1;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await popup.waitForURL(url => url.protocol === "https:" && url.hostname === "accounts.google.com", { timeout: BROWSER_PAGE_TIMEOUT_MS });
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
            if (popup.isClosed()) {
                // Google may close immediately after sign-in, without a Continue screen.
                // The captured Tango login response below remains the success criterion.
                return;
            }
            logger.error(`Google login attempt ${attempt} failed for ${account.email}.`, { error: error.message });
            if (attempt === maxRetries) throw error;
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
        let responseCaptured = false;
        const responsePromise = context.waitForEvent("response", {
            predicate: response => isTangoLoginResponse(response.url(), response.status()),
            timeout: BROWSER_RESPONSE_TIMEOUT_MS,
        }).then(response => { responseCaptured = true; return response; });
        void responsePromise.catch(() => {}); // Browser cleanup may cancel this waiter.
        const popupPromise = page.waitForEvent("popup", { timeout: BROWSER_PAGE_TIMEOUT_MS });

        await page.goto(constants.TANGO_URLS.HOME, { waitUntil: "domcontentloaded", timeout: BROWSER_PAGE_TIMEOUT_MS });

        await findAndClickLoginButton(page, account);
        const googlePopup = await popupPromise;
        // A valid Tango response is authoritative; the optional Google Continue screen
        // may disappear, or the popup may stay open briefly after that response.
        void handleGoogleLogin(googlePopup, account).catch(error => {
            if (!responseCaptured) logger.warn("Google login interaction ended before the Tango response", { error: error.message });
        });
        const response = await responsePromise;
        const responseURL = new URL(response.url());
        logger.info("Captured Tango login response", {
            host: responseURL.host,
            path: responseURL.pathname,
            page: response.frame().page() === page ? "main" : "popup",
        });
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
    const diagnosticsDirectory = path.join(os.homedir(), ".local/state/video-services/tango-login");
    const attentionFile = path.join(diagnosticsDirectory, createHash("sha256").update(account.email).digest("hex") + ".attention.json");
    if (await access(attentionFile).then(() => true, () => false)) throw new BrowserLoginNeedsAttentionError();
    logger.info(`Acquiring browser for ${account.email}`);
    let browser: Browser;
    browser = await chromium.launch({
        headless: false,
        slowMo: process.env.TANGO_LOGIN_VISIBLE === "1" ? 200 : undefined,
        args: ["--disable-blink-features=AutomationControlled", "--disable-gpu", "--disable-gpu-compositing"],
    });
    let loginTimer: ReturnType<typeof setTimeout> | undefined;
    try {
        const timeoutPromise = new Promise<never>((_, reject) => {
            loginTimer = setTimeout(() => reject(new Error("Browser login flow timed out")), BROWSER_LOGIN_FLOW_TIMEOUT_MS);
        });

        return await Promise.race([
            runLoginFlow(browser, account),
            timeoutPromise
        ]);
    } catch (ignoredError) {
        const directory = diagnosticsDirectory;
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const prefix = path.join(directory, String(Date.now()));
        const pages = browser.contexts().flatMap(context => context.pages());
        const states = [];
        for (let index = 0; index < pages.length; index++) {
            const page = pages[index];
            if (page.isClosed()) continue;
            try {
                const url = new URL(page.url());
                states.push({ host: url.host, path: url.pathname, text: (await page.locator("body").innerText({ timeout: 2000 })).slice(0, 3000) });
                await page.screenshot({ path: `${prefix}-${index}.png`, timeout: 3000 });
            } catch { /* Keep the original login error. */ }
        }
        const message = ignoredError instanceof Error ? ignoredError.message : "Tango login failed";
        await writeFile(`${prefix}.json`, JSON.stringify({ message, pages: states }, null, 2), { mode: 0o600 });
        logger.error("Tango browser login did not finish", { error: message, diagnostics: prefix });
        if (states.some(state => (state.host === "google.com" || state.host.endsWith(".google.com")) && /too many failed attempts|wrong password|couldn.t sign you in|couldn.t verify|verify it.s you|check your phone|enter (?:the )?code/i.test(state.text))) {
            await writeFile(attentionFile, JSON.stringify({ time: Date.now(), reason: "Google requires user verification", diagnostics: prefix }), { mode: 0o600 });
            throw new BrowserLoginNeedsAttentionError();
        }
        return null;
    } finally {
        if (loginTimer) clearTimeout(loginTimer);
        await browser.close();
        logger.info(`Browser released for ${account.email}.`);
    }
}
