import { chromium, Browser, Page } from "playwright";
import logger from "../../../common/logger.js";

export class ScPageController {
    private browser: Browser | null = null;
    private page: Page | null = null;
    public readonly channelName: string;

    // State
    public targetDuration: number = 2;
    private segmentQueue: Buffer[] = [];
    private producedSegmentCount: number = 0;
    private headSequence: number = 0;

    constructor(channelName: string) {
        this.channelName = channelName;
    }

    public async start(): Promise<void> {
        logger.info(`[SC] [${this.channelName}] Launching browser instance (Headful - Stream Recorder Mode)...`);

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
                userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                permissions: ['microphone', 'camera'] // sometimes needed for captureStream
            });

            this.page = await context.newPage();

            // 1. Expose binding to receive chunks from browser context
            await this.page.exposeFunction("nodeOnChunk", (base64Data: string) => {
                const buf = Buffer.from(base64Data, "base64");
                this.segmentQueue.push(buf);
                this.producedSegmentCount++;
                logger.debug(`[SC] [${this.channelName}] Received chunk #${this.producedSegmentCount} (${buf.length} bytes). Queue: ${this.segmentQueue.length}`);

                if (this.segmentQueue.length > 50) {
                    this.segmentQueue.shift();
                    this.headSequence++;
                }
            });

            const targetUrl = `https://stripchat.com/${this.channelName}`;
            logger.info(`[SC] [${this.channelName}] Navigating to ${targetUrl}`);

            await this.page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

            // 2. Handle Age Gate
            try {
                const enterBtn = this.page.locator('.btn-visitors-agreement-accept').first();
                if (await enterBtn.isVisible({ timeout: 5000 })) {
                    await enterBtn.click();
                }
            } catch (e) {}

            // 3. Inject Recorder Script
            // We wait a bit for the video element to populate
            await this.page.waitForTimeout(5000);

            await this.page.evaluate(() => {
                const CHECK_INTERVAL = 1000;

                const startRecording = () => {
                    const video = document.querySelector('video');
                    if (!video) {
                        console.log("No video element found yet...");
                        return false;
                    }

                    // Ensure it's playing
                    if (video.paused) {
                        console.log("Video paused, forcing play...");
                        video.muted = true;
                        video.play().catch(e => console.error("Play failed", e));
                    }

                    // Check if already captured
                    if ((window as any).__isRecording) return true;

                    try {
                        console.log("Found video, capturing stream...");
                        const stream = (video as any).captureStream ? (video as any).captureStream() : (video as any).mozCaptureStream();
                        if (!stream) {
                            console.error("captureStream not supported");
                            return false;
                        }

                        // Use specific mimeType if supported, else default (usually video/webm; codecs=vp8/opus)
                        let options = { mimeType: 'video/webm;codecs=vp8' };
                        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                            options = { mimeType: 'video/webm' }; // Fallback
                        }

                        const mediaRecorder = new MediaRecorder(stream, options);
                        (window as any).__mediaRecorder = mediaRecorder;
                        (window as any).__isRecording = true;

                        mediaRecorder.ondataavailable = async (e) => {
                            if (e.data && e.data.size > 0) {
                                // Convert Blob to Base64 to send to Node
                                const reader = new FileReader();
                                reader.onloadend = () => {
                                    const base64 = (reader.result as string).split(',')[1];
                                    (window as any).nodeOnChunk(base64);
                                };
                                reader.readAsDataURL(e.data);
                            }
                        };

                        // Start recording with 2000ms timeslices
                        mediaRecorder.start(2000);
                        console.log("MediaRecorder started!");
                        return true;

                    } catch (e) {
                        console.error("Recorder error:", e);
                        return false;
                    }
                };

                // Polling loop to ensure we attach if video reloads/changes
                setInterval(() => {
                    startRecording();
                }, CHECK_INTERVAL);
            });

        } catch (error: any) {
            logger.error(`[SC] [${this.channelName}] Browser startup failed`, { error: error.message });
            await this.stop();
        }
    }

    public getAvailableSegments(): number[] {
        const available: number[] = [];
        for (let i = 0; i < this.segmentQueue.length; i++) {
            available.push(this.headSequence + i);
        }
        return available;
    }

    public popSegment(sequenceId: number): Buffer | null {
        if (sequenceId === this.headSequence) {
            const buf = this.segmentQueue.shift();
            if (buf) {
                this.headSequence++;
                return buf;
            }
        }
        return null;
    }

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