// src/browser/playwrightLogin.ts
import { chromium, Browser, Page } from "playwright";
import * as timersPromises from "timers/promises";

import logger from "../common/logger.js";
import * as constants from "../common/constants.js";
import * as types from "../common/types.js";

/**
 * Launches Playwright to perform a full browser login and intercept the initial tokens.
 */
export async function extractTokens(): Promise<types.LoginResult> {
    // --- Step 1: Setup and Environment Variables ---
    // This is identical to the Puppeteer setup. We get the credentials from environment
    // variables to avoid hardcoding them.
    const email = process.env.GOOGLE_EMAIL;
    const password = process.env.GOOGLE_PASSWORD;
    if (!(email && password)) {
        throw new Error("Could not find GOOGLE_EMAIL or GOOGLE_PASSWORD in environment variables.");
    }

    let browser: Browser | undefined;

    // The main try...finally block ensures that the browser is always closed,
    // even if an error occurs during the login process.
    try {
        // --- Step 2: Launching the Browser ---
        // Here, we launch a Chromium browser instance.
        // Why this choice?
        // - `chromium.launch()` is Playwright's equivalent of `puppeteer.launch()`.
        // - `headless: false` makes the browser UI visible, which is essential for debugging.
        // - `args: ["--disable-blink-features=AutomationControlled"]` helps the browser appear less like an automated bot.
        //
        // Playwright vs. Puppeteer:
        // - Playwright can also launch Firefox (`firefox.launch()`) and WebKit (`webkit.launch()`),
        //   while Puppeteer primarily focuses on Chromium.
        // - The launch options are very similar between the two libraries.
        logger.info("Playwright: Launching browser for automatic login...");
        browser = await chromium.launch({
            headless: false,
            args: ["--disable-blink-features=AutomationControlled"],
        });

        // --- Step 3: Creating a Browser Context and Page ---
        // This is a key difference from Puppeteer. Playwright introduces the concept of a "Browser Context".
        // Why this choice?
        // - A Browser Context is like an isolated "incognito" session. It doesn't share cookies or cache
        //   with other contexts. This is great for running tests or tasks in parallel without interference.
        // - We can set options like viewport size and user agent directly on the context, which is a cleaner
        //   approach than setting them on the page later.
        //
        // Playwright vs. Puppeteer:
        // - Puppeteer creates pages directly from the browser instance (`browser.newPage()`).
        // - Playwright's flow is `browser -> newContext() -> newPage()`, providing better isolation.
        const context = await browser.newContext({
            viewport: { width: 1500, height: 1000 },
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        });
        const page: Page = await context.newPage();

        // --- Step 4: Setting up Token Interception ---
        // This logic is crucial for capturing the authentication tokens. We listen for network responses.
        //
        // Why this choice?
        // - The `page.on('response', ...)` event listener fires for every HTTP response the page receives.
        // - We check if the response URL matches the one we expect after a successful Google login.
        // - `response.headersArray()` is the most robust way to get all headers, as it correctly handles
        //   multiple 'set-cookie' headers, which is a common occurrence.
        //
        // Playwright vs. Puppeteer:
        // - The event listener API is almost identical.
        // - Puppeteer's `response.headers()['set-cookie']` returns a single string that might contain newlines,
        //   requiring manual splitting. Playwright's `response.headersArray()` is more structured and reliable
        //   for this specific task.
        const tokenPromise = new Promise<types.LoginResult>((resolve, reject) => {
            page.on("response", async (response) => {
                if (response.url() === constants.TANGO_URLS.GOOGLE_LOGIN) {
                    let foundRT: string | null = null;
                    let foundST: string | null = null;

                    const headers = await response.headersArray();
                    const setCookieHeaders = headers.filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value);

                    for (const cookie of setCookieHeaders) {
                        if (cookie.trim().startsWith(constants.COOKIE_NAMES.TANGO_RT_PREFIX)) {
                            foundRT = cookie.split(";")[0].substring(constants.COOKIE_NAMES.TANGO_RT_PREFIX.length);
                        }
                        if (cookie.trim().startsWith(constants.COOKIE_NAMES.TANGO_ST_PREFIX)) {
                            foundST = cookie.split(";")[0].substring(constants.COOKIE_NAMES.TANGO_ST_PREFIX.length);
                        }
                    }

                    if (foundRT && foundST) {
                        logger.info("Playwright intercepted Tango-RT and Tango-ST tokens.");
                        resolve({ tangoRT: foundRT, tangoST: foundST });
                    }
                }
            });
            timersPromises.setTimeout(120000).then(() => reject(new Error("Timeout: Did not complete login within 120 seconds.")));
        });

        // --- Step 5: Navigation and Initial Login Click ---
        // We navigate to the homepage and begin the login process.
        //
        // Why this choice?
        // - `page.goto()` navigates the page. `waitUntil: 'networkidle'` waits until network activity has ceased,
        //   ensuring the page and its scripts are fully loaded.
        // - We use Playwright's "Locators" (`page.getByTestId`, `page.getByRole`). Locators are the modern,
        //   preferred way to interact with elements. They automatically wait for elements to be ready,
        //   making the script much more stable and removing the need for manual waits (`setTimeout`).
        // - The logic first checks for the direct Google button. If it's not found, it clicks the more general
        //   "Log in" button to reveal it. The `.or()` chain is a powerful way to handle multiple possible selectors.
        //
        // Playwright vs. Puppeteer:
        // - Playwright's Locators and auto-waiting are its biggest advantages. Puppeteer requires more manual
        //   `waitForSelector` and `try-catch` blocks for the same level of robustness.
        // - The `.or()` method for locators is unique to Playwright and simplifies handling UI variations.
        await page.goto(constants.TANGO_URLS.HOME, { waitUntil: "networkidle" });
        await timersPromises.setTimeout(5000); // A small static wait can still be helpful for client-side frameworks to initialize.

        const googleButton = page.getByTestId("GOOGLE");
        try {
            await googleButton.waitFor({ state: "visible", timeout: 5000 });
        } catch (e) {
            logger.warn("Direct Google login button not found, trying the main login flow...");
            const loginButton = page.getByTestId("home-page-login-register-button").or(page.getByRole("button", { name: /Log in \/ Sign up/i }));
            await loginButton.click();
        }

        // --- Step 6: Handling the Google Login Popup ---
        // This is the idiomatic Playwright way to handle new windows or tabs.
        //
        // Why this choice?
        // - `page.waitForEvent('popup')` sets up a listener for the popup *before* we click the button that opens it.
        // - `Promise.all` waits for both the event and the click action to happen concurrently. This is a race-condition-free
        //   way to guarantee we capture the popup page object.
        //
        // Playwright vs. Puppeteer:
        // - This is far simpler and more reliable than Puppeteer's `browser.waitForTarget()`, which is more verbose
        //   and involves manually checking target URLs.
        logger.info("Clicking Google login button and waiting for popup...");
        const [popup] = await Promise.all([
            page.waitForEvent("popup"), // Wait for the popup to open
            googleButton.click(), // The action that opens the popup
        ]);

        await popup.waitForLoadState(); // Ensure the popup page is fully loaded
        logger.info("Google popup detected. Starting authentication process...");

        // --- Step 7: Interacting with the Popup and Submitting Credentials ---
        // This block handles the multi-step Google login form.
        //
        // Why this choice?
        // - We use a `for` loop for retries, which is a good pattern for handling network flakiness during login.
        // - We use locators like `getByRole` and `locator('#identifierId')` for interaction. `fill` is used for typing,
        //   as it's faster and more reliable than simulating individual key presses.
        // - We check if an element is visible before interacting with it (`.isVisible()`). This handles cases where
        //   Google remembers the email and skips directly to the password or "Continue" step.
        // - `popup.waitForEvent('close')` is a clean way to confirm the login was successful and the popup has closed.
        //
        // Playwright vs. Puppeteer:
        // - Again, Playwright's auto-waiting locators shine. We don't need manual `setTimeout` calls between actions
        //   like typing and clicking, as Playwright waits for the element to be ready automatically. This makes the
        //   script faster and less brittle.
        // - Puppeteer's `locator("::-p-aria(Next)")` is a non-standard syntax. Playwright's `getByRole('button', { name: 'Next' })`
        //   is based on accessibility standards and is more readable.
        const maxGoogleRetries = 3;
        for (let attempt = 1; attempt <= maxGoogleRetries; attempt++) {
            try {
                logger.info(`Google login attempt ${attempt}/${maxGoogleRetries}...`);

                const emailInput = popup.locator("#identifierId");
                if (await emailInput.isVisible({ timeout: 5000 }).catch(() => false)) {
                    logger.info("Email input found. Entering email.");
                    await emailInput.fill(email);
                    await popup.getByRole("button", { name: "Next" }).click();
                } else {
                    logger.info("Email input not found, skipping to next step.");
                }

                const passwordInput = popup.locator('input[type="password"]');
                if (await passwordInput.isVisible({ timeout: 5000 }).catch(() => false)) {
                    logger.info("Password input found. Entering password.");
                    await passwordInput.fill(password);
                    await popup.getByRole("button", { name: "Next" }).click();
                } else {
                    logger.info("Password input not found, skipping to next step.");
                }

                logger.info("Looking for 'Continue' button...");
                await popup.getByRole("button", { name: "Continue" }).click({ timeout: 15000 });

                logger.info("Clicked 'Continue'. Waiting for popup to close...");
                await popup.waitForEvent("close", { timeout: 20000 });

                logger.info("Google popup closed successfully. Authentication complete.");
                break; // Success!
            } catch (error) {
                logger.error(`Google login attempt ${attempt} failed.`, { error: (error as Error).message });
                if (attempt === maxGoogleRetries) {
                    throw new Error(`Failed to log in via Google after ${maxGoogleRetries} attempts.`);
                }
                if (!popup.isClosed()) {
                    logger.warn("Popup is still open. Reloading it for the next attempt...");
                    await popup.reload({ waitUntil: "networkidle" });
                } else {
                    throw new Error("Google popup closed unexpectedly. Cannot retry.");
                }
            }
        }

        // --- Step 8: Finalizing ---
        // We await the promise that has been listening for tokens all along.
        const tokens = await tokenPromise;
        logger.info("Initial refresh token found via Playwright.");
        return tokens;
    } catch (error) {
        logger.error("Failed to extract initial tokens via Playwright.", { error });
        throw error;
    } finally {
        // --- Step 9: Closing the Browser ---
        // This is critical to prevent orphaned browser processes from consuming resources.
        if (browser) {
            logger.info("Closing browser...");
            await browser.close();
        }
    }
}
