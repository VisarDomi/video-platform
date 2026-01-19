import { chromium, Browser, Page } from "playwright";
import logger from "../../../common/logger.js";

export class ScPageController {
    private browser: Browser | null = null;
    private page: Page | null = null;
    public readonly channelName: string;

    // State
    public targetDuration: number = 2; // Default from HAR
    private segmentQueue: Buffer[] = [];

    // Counter for unique segment names
    private producedSegmentCount: number = 0;

    // We expose a snapshot of currently available segments
    // Each element is { id: number, buffer: Buffer }?
    // No, we keep it simple. The queue holds buffers.
    // We track the 'sequence' of the HEAD of the queue.
    private headSequence: number = 0;

    constructor(channelName: string) {
        this.channelName = channelName;
    }

    public async start(): Promise<void> {
        logger.info(`[SC] [${this.channelName}] Launching browser instance (Headful)...`);

        try {
            this.browser = await chromium.launch({
                headless: false,
                args: [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--mute-audio",
                    "--window-size=1280,720"
                ],
            });

            const context = await this.browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            });

            this.page = await context.newPage();

            // Setup Interception
            this.page.on("response", async (response) => {
                const url = response.url();
                const status = response.status();

                if (status !== 200) return;

                // 1. Sniff Target Duration
                if (url.includes(".m3u8") || response.headers()["content-type"] === "application/vnd.apple.mpegurl") {
                    try {
                        const content = await response.text();
                        const match = content.match(/#EXT-X-TARGETDURATION:(\d+(\.\d+)?)/);
                        if (match && match[1]) {
                            this.targetDuration = parseFloat(match[1]);
                        }
                    } catch (e) {}
                }

                // 2. Intercept Segments
                if (url.includes(".mp4") || response.headers()["content-type"] === "video/mp4") {
                    try {
                        const buffer = await response.body();
                        // Filter very small files (e.g. init segments < 1KB)
                        if (buffer.length > 1000) {
                            this.segmentQueue.push(buffer);
                            this.producedSegmentCount++;
                            logger.debug(`[SC] [${this.channelName}] Queued segment #${this.producedSegmentCount}. Queue size: ${this.segmentQueue.length}`);

                            // Safety limit
                            if (this.segmentQueue.length > 50) {
                                this.segmentQueue.shift();
                                this.headSequence++; // We dropped one, so head moves
                            }
                        }
                    } catch (e) {}
                }
            });

            const targetUrl = `https://stripchat.com/${this.channelName}`;
            logger.info(`[SC] [${this.channelName}] Navigating to ${targetUrl}`);

            await this.page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

            try {
                const enterBtn = this.page.locator('button:has-text("Enter")').first();
                if (await enterBtn.isVisible({ timeout: 5000 })) {
                    await enterBtn.click();
                }
            } catch (e) {}

        } catch (error: any) {
            logger.error(`[SC] [${this.channelName}] Browser startup failed`, { error: error.message });
            await this.stop();
        }
    }

    public getAvailableSegments(): number[] {
        // Return ID/Sequence numbers for current queue items
        const available: number[] = [];
        for (let i = 0; i < this.segmentQueue.length; i++) {
            available.push(this.headSequence + i);
        }
        return available;
    }

    public popSegment(sequenceId: number): Buffer | null {
        // We only support popping the HEAD.
        // If the requested ID is < headSequence, it's gone.
        // If it's > headSequence, we are out of sync/it's not ready.
        // Ideally, we just check if sequenceId matches headSequence.

        if (sequenceId === this.headSequence) {
            const buf = this.segmentQueue.shift();
            if (buf) {
                this.headSequence++;
                return buf;
            }
        }
        return null;
    }

    // For "greedy" popping regardless of ID (fallback)
    public popNext(): Buffer | null {
        const buf = this.segmentQueue.shift();
        if (buf) this.headSequence++;
        return buf || null;
    }

    public async stop(): Promise<void> {
        if (this.browser) {
            try { await this.browser.close(); } catch (e) {}
            this.browser = null;
            this.page = null;
            this.segmentQueue = [];
        }
    }

    public isActive(): boolean {
        return this.browser !== null;
    }
}