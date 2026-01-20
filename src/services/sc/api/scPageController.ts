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
                    "--window-size=1280,720",
                    // Enable features for MP4 recording if available
                    "--enable-features=MediaRecorderInMP4"
                ],
            });

            const context = await this.browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                permissions: ['microphone', 'camera']
            });

            this.page = await context.newPage();

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

            try {
                const enterBtn = this.page.locator('.btn-visitors-agreement-accept').first();
                if (await enterBtn.isVisible({ timeout: 5000 })) {
                    await enterBtn.click();
                }
            } catch (e) {}

            await this.page.waitForTimeout(5000);

            await this.page.evaluate(() => {
                const CHECK_INTERVAL = 1000;

                const startRecording = () => {
                    const video = document.querySelector('video');
                    if (!video) return false;

                    if (video.paused) {
                        video.muted = true;
                        video.play().catch(e => console.error("Play failed", e));
                    }

                    if ((window as any).__isRecording) return true;

                    try {
                        const stream = (video as any).captureStream ? (video as any).captureStream() : (video as any).mozCaptureStream();
                        if (!stream) return false;

                        // ATTEMPT TO FORCE MP4
                        // Chrome typically supports 'video/webm;codecs=h264' or just 'video/webm'
                        // Newer Chrome supports 'video/mp4'
                        const mimeTypes = [
                            'video/mp4;codecs=avc1,mp4a',
                            'video/mp4',
                            'video/webm;codecs=h264',
                            'video/webm;codecs=vp9',
                            'video/webm'
                        ];

                        let selectedMime = "";
                        for (const type of mimeTypes) {
                            if (MediaRecorder.isTypeSupported(type)) {
                                selectedMime = type;
                                console.log(`[Recorder] Supported MIME: ${type}`);
                                break;
                            }
                        }

                        if (!selectedMime) {
                            console.error("[Recorder] No supported MIME types found.");
                            return false;
                        }

                        const options = { mimeType: selectedMime };
                        const mediaRecorder = new MediaRecorder(stream, options);
                        (window as any).__mediaRecorder = mediaRecorder;
                        (window as any).__isRecording = true;

                        mediaRecorder.ondataavailable = async (e) => {
                            if (e.data && e.data.size > 0) {
                                const reader = new FileReader();
                                reader.onloadend = () => {
                                    const base64 = (reader.result as string).split(',')[1];
                                    (window as any).nodeOnChunk(base64);
                                };
                                reader.readAsDataURL(e.data);
                            }
                        };

                        mediaRecorder.start(2000);
                        console.log(`[Recorder] Started with ${selectedMime}`);
                        return true;

                    } catch (e) {
                        console.error("[Recorder] Error:", e);
                        return false;
                    }
                };

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