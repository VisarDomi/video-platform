import { chromium, Browser, Page } from "playwright";
import logger from "../../../common/logger.js";

export interface ScSniffResult {
    url: string;
    headers: Record<string, string>;
    cookies: string; // Cookie header string
}

export class ScBrowserService {
    private static instance: ScBrowserService;
    private browser: Browser | null = null;
    private readonly HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    };

    private constructor() {}

    public static getInstance(): ScBrowserService {
        if (!ScBrowserService.instance) {
            ScBrowserService.instance = new ScBrowserService();
        }
        return ScBrowserService.instance;
    }

    private async init(): Promise<void> {
        if (this.browser) return;

        logger.info("[SC] Launching Playwright browser (Sniffer Mode)...");
        try {
            this.browser = await chromium.launch({
                headless: true,
                args: ["--no-sandbox", "--disable-setuid-sandbox", "--mute-audio"],
            });
        } catch (error: any) {
            logger.error("[SC] Failed to launch browser", { error: error.message });
        }
    }

    public async sniffPlaylist(channelName: string): Promise<ScSniffResult | null> {
        await this.init();
        if (!this.browser) return null;

        let page: Page | null = null;
        let result: ScSniffResult | null = null;

        try {
            const context = await this.browser.newContext({
                userAgent: this.HEADERS["User-Agent"],
                viewport: { width: 1280, height: 720 },
            });

            page = await context.newPage();

            // Intercept requests to find the M3U8
            // We listen to 'request' event to get headers sent BY the browser
            // We listen to 'response' to filter for success
            const urlPattern = /doppiocdn\.com.*\.m3u8/;

            // Create a promise that resolves when the playlist is found
            const playlistPromise = new Promise<ScSniffResult>((resolve, reject) => {
                const timeout = setTimeout(() => reject("Timeout"), 30000);

                page!.on("request", async (request) => {
                    const url = request.url();
                    if (urlPattern.test(url) && !url.includes("playlistType=lowLatency")) {
                        // We prefer standard latency if available, or just take what we get
                        // Usually the player requests the master first, then variant
                    }
                });

                page!.on("response", async (response) => {
                    const url = response.url();
                    if (urlPattern.test(url) && response.status() === 200) {
                        // Found a valid playlist response
                        const req = response.request();
                        const allHeaders = await req.allHeaders();

                        // Extract cookies formatted for header
                        const cookies = await context.cookies(url);
                        const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join("; ");

                        resolve({
                            url: url,
                            headers: allHeaders,
                            cookies: cookieStr
                        });
                        clearTimeout(timeout);
                    }
                });
            });

            const targetUrl = `https://stripchat.com/${channelName}`;
            logger.info(`[SC] Sniffing ${targetUrl} for M3U8...`);

            await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

            // Click a "Enter" button if it exists (age gate)
            try {
                const enterBtn = page.locator('button:has-text("Enter")').first();
                if (await enterBtn.isVisible()) {
                    await enterBtn.click();
                }
            } catch (e) {}

            result = await playlistPromise;
            logger.info(`[SC] Sniffed valid playlist: ${result.url}`);

        } catch (error: any) {
            logger.warn(`[SC] Sniffing failed for ${channelName}: ${error.message || error}`);
        } finally {
            if (page) await page.close();
        }

        return result;
    }

    public async close(): Promise<void> {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
    }
}