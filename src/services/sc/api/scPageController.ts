import { chromium, Browser, Page } from "playwright";
import logger from "../../../common/logger.js";

export class ScPageController {
    private browser: Browser | null = null;
    private page: Page | null = null;
    private channelName: string;

    // State
    private latestPlaylistUrl: string | null = null;
    private latestPlaylistContent: string | null = null;

    // Store segments: Url -> Buffer
    // We use a simple map. In a long running stream, we rely on read-and-delete
    // or a primitive cleanup to avoid OOM.
    private segmentBuffer: Map<string, Buffer> = new Map();
    private lastActivity: number = Date.now();

    constructor(channelName: string) {
        this.channelName = channelName;
    }

    public async start(): Promise<void> {
        logger.info(`[SC] [${this.channelName}] Launching browser instance...`);

        try {
            this.browser = await chromium.launch({
                headless: true,
                args: ["--no-sandbox", "--disable-setuid-sandbox", "--mute-audio"],
            });

            const context = await this.browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            });

            this.page = await context.newPage();

            // Setup Interception
            this.page.on("response", async (response) => {
                const url = response.url();
                const type = response.request().resourceType();
                const status = response.status();

                if (status !== 200) return;

                // 1. Intercept Playlist (M3U8)
                // Do not intercept master playlists (usually contain /master/), only variants
                if ((url.includes(".m3u8") || response.headers()["content-type"] === "application/vnd.apple.mpegurl") && !url.includes("/master/")) {
                    try {
                        const content = await response.text();
                        if (content.includes("#EXTINF")) {
                            this.latestPlaylistUrl = url;
                            this.latestPlaylistContent = content;
                            this.lastActivity = Date.now();
                            // logger.debug(`[SC] [${this.channelName}] Intercepted playlist.`);
                        }
                    } catch (e) {
                        // ignore
                    }
                }

                // 2. Intercept Segments (MP4)
                if (url.includes(".mp4") || response.headers()["content-type"] === "video/mp4") {
                    try {
                        // Buffer the segment
                        const buffer = await response.body();
                        this.segmentBuffer.set(url, buffer);
                        this.lastActivity = Date.now();

                        // Safety: Prune old segments if map gets too big (stuck consumer)
                        if (this.segmentBuffer.size > 50) {
                            const firstKey = this.segmentBuffer.keys().next().value;
                            if (firstKey) this.segmentBuffer.delete(firstKey);
                        }

                        logger.debug(`[SC] [${this.channelName}] Intercepted segment: ${url.split('/').pop()}`);
                    } catch (e) {
                        // ignore
                    }
                }
            });

            const targetUrl = `https://stripchat.com/${this.channelName}`;
            logger.info(`[SC] [${this.channelName}] Navigating to ${targetUrl}`);

            await this.page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

            // Handle Age Gate
            try {
                const enterBtn = this.page.locator('button:has-text("Enter")').first();
                if (await enterBtn.isVisible({ timeout: 5000 })) {
                    logger.info(`[SC] [${this.channelName}] Clicking Age Gate 'Enter'...`);
                    await enterBtn.click();
                }
            } catch (e) {
                // Ignore, might not exist
            }

        } catch (error: any) {
            logger.error(`[SC] [${this.channelName}] Browser startup failed`, { error: error.message });
            await this.stop();
        }
    }

    public getLatestPlaylist(): { url: string, content: string } | null {
        if (this.latestPlaylistUrl && this.latestPlaylistContent) {
            return {
                url: this.latestPlaylistUrl,
                content: this.latestPlaylistContent
            };
        }
        return null;
    }

    public getSegment(url: string): Buffer | null {
        // Precise match first
        if (this.segmentBuffer.has(url)) {
            const buf = this.segmentBuffer.get(url)!;
            this.segmentBuffer.delete(url); // Delete on read to save memory
            return buf;
        }
        return null;
    }

    public async stop(): Promise<void> {
        if (this.browser) {
            logger.info(`[SC] [${this.channelName}] Closing browser.`);
            try {
                await this.browser.close();
            } catch (e) {}
            this.browser = null;
            this.page = null;
            this.segmentBuffer.clear();
        }
    }

    public isActive(): boolean {
        return this.browser !== null;
    }
}