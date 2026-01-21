import { chromium, Browser, Page } from "playwright";
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import logger from "../../../common/logger.js";
import { ScQualityManager } from "./scQualityManager.js";

export class ScPageController {
    private browser: Browser | null = null;
    private page: Page | null = null;
    public readonly channelName: string;
    private qualityManager: ScQualityManager | null = null;
    private cookieInterval: NodeJS.Timeout | null = null;

    private ffmpegProcess: ChildProcess | null = null;
    public readonly tempDir: string;

    constructor(channelName: string) {
        this.channelName = channelName;
        this.tempDir = path.join(os.tmpdir(), `sc_capture_${channelName}`);
    }

    public async start(): Promise<void> {
        logger.info(`[SC] [${this.channelName}] Launching browser + FFmpeg (System Chromium)...`);

        try {
            await fs.rm(this.tempDir, { recursive: true, force: true });
            await fs.mkdir(this.tempDir, { recursive: true });
        } catch (e) {
            logger.error(`[SC] Failed to create temp dir ${this.tempDir}`);
            return;
        }

        // Added -thread_queue_size to help with stdin buffering
        this.ffmpegProcess = spawn("ffmpeg", [
            "-loglevel", "info",
            "-y",
            "-thread_queue_size", "1024",
            "-f", "webm",
            "-i", "pipe:0",

            "-c:v", "copy",
            "-c:a", "aac",
            "-b:a", "128k",

            "-f", "hls",
            "-hls_time", "2",
            "-hls_list_size", "10",
            "-hls_flags", "delete_segments",
            "-hls_segment_filename", path.join(this.tempDir, "segment_%03d.ts"),
            path.join(this.tempDir, "playlist.m3u8")
        ]);

        this.ffmpegProcess.stderr?.on("data", (data) => {
            const msg = data.toString().trim();
            if (msg) logger.debug(`[FFmpeg] ${msg}`);
        });

        this.ffmpegProcess.on("exit", (code) => {
            logger.info(`[SC] FFmpeg exited (code ${code})`);
        });

        try {
            this.browser = await chromium.launch({
                executablePath: "/usr/bin/chromium",
                headless: false,
                args: [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--mute-audio",
                    "--window-size=1920,1080",
                    "--enable-features=MediaRecorderInMP4"
                ],
            });

            const context = await this.browser.newContext({
                viewport: { width: 1920, height: 1080 },
                userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                permissions: ['microphone', 'camera']
            });

            this.page = await context.newPage();

            this.page.on("console", msg => {
                // Restore logs to debug recorder issues
                logger.debug(`[Browser Console] ${msg.text()}`);
            });

            await this.page.exposeFunction("nodeOnChunk", (base64Data: string, seqId: number) => {
                if (this.ffmpegProcess && this.ffmpegProcess.stdin && !this.ffmpegProcess.stdin.destroyed) {
                    try {
                        const buf = Buffer.from(base64Data, "base64");
                        const flushed = this.ffmpegProcess.stdin.write(buf);
                        if (!flushed) {
                            // logger.warn(`[Node] FFmpeg stdin buffer full at chunk #${seqId}. Backpressure!`);
                            // We can try to listen for 'drain' but in this sync callback loop it's hard.
                            // Just letting Node handle the buffer is usually okay unless it grows infinite.
                        }
                    } catch (e: any) {
                        logger.warn(`[SC] Failed to write chunk #${seqId}: ${e.message}`);
                    }
                }
            });

            const targetUrl = `https://stripchat.com/${this.channelName}`;
            await this.page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
            await this.page.addStyleTag({ content: ".view-cam-watching-limit { display: none !important; }" });

            this.startCookieLooper();

            try {
                const enterBtn = this.page.locator('.btn-visitors-agreement-accept').first();
                if (await enterBtn.isVisible({ timeout: 5000 })) {
                    await enterBtn.click();
                }
            } catch (e) {}

            await this.page.waitForTimeout(5000);

            this.qualityManager = new ScQualityManager(this.page);
            this.qualityManager.start();

            await this.page.evaluate(() => {
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
                        if (!stream) {
                            console.error("No stream found from captureStream()");
                            return false;
                        }

                        const mimeType = 'video/webm;codecs=h264';
                        if (!MediaRecorder.isTypeSupported(mimeType)) {
                            console.error(`Browser DOES NOT support ${mimeType}`);
                            return false;
                        }

                        const mediaRecorder = new MediaRecorder(stream, { mimeType });
                        (window as any).__mediaRecorder = mediaRecorder;
                        (window as any).__isRecording = true;

                        const queue: { blob: Blob, seq: number }[] = [];
                        let isProcessing = false;
                        let seqCounter = 0;

                        const processQueue = async () => {
                            if (isProcessing) return;
                            isProcessing = true;

                            while (queue.length > 0) {
                                const item = queue.shift();
                                if (!item) continue;
                                await new Promise<void>((resolve) => {
                                    const reader = new FileReader();
                                    reader.readAsArrayBuffer(item.blob);
                                    reader.onloadend = async () => {
                                        if (reader.result instanceof ArrayBuffer) {
                                            const buffer = reader.result;
                                            const bytes = new Uint8Array(buffer);
                                            let binary = '';
                                            const len = bytes.byteLength;
                                            // Chunking large strings to avoid stack overflow in some browsers
                                            const CHUNK_SIZE = 8192;
                                            for (let i = 0; i < len; i += CHUNK_SIZE) {
                                                const chunk = bytes.subarray(i, i + CHUNK_SIZE);
                                                binary += String.fromCharCode.apply(null, Array.from(chunk));
                                            }
                                            const base64 = window.btoa(binary);
                                            await (window as any).nodeOnChunk(base64, item.seq);
                                        }
                                        resolve();
                                    };
                                    reader.onerror = () => resolve();
                                });
                            }
                            isProcessing = false;
                        };

                        mediaRecorder.ondataavailable = (e) => {
                            if (e.data && e.data.size > 0) {
                                seqCounter++;
                                queue.push({ blob: e.data, seq: seqCounter });
                                processQueue();
                            }
                        };

                        mediaRecorder.start(1000);
                        console.log(`[Recorder] Started with ${mimeType}`);
                        return true;

                    } catch (e: any) {
                        console.error("Recorder Error: " + e.message);
                        return false;
                    }
                };
                setInterval(startRecording, 1000);
            });

        } catch (error: any) {
            logger.error(`[SC] [${this.channelName}] Browser startup failed`, { error: error.message });
            await this.stop();
        }
    }

    private startCookieLooper(): void {
        if (this.cookieInterval) clearInterval(this.cookieInterval);
        this.cookieInterval = setInterval(async () => {
            if (!this.page || this.page.isClosed()) return;
            try {
                const cookieBtn = this.page.locator('.cookies-reminder__accept-all-button, .ds-btn-apply-2-ds').first();
                if (await cookieBtn.isVisible()) {
                    await cookieBtn.click({ force: true });
                }
            } catch (e) {}
        }, 60000);
    }

    public async stop(): Promise<void> {
        if (this.cookieInterval) {
            clearInterval(this.cookieInterval);
            this.cookieInterval = null;
        }
        this.qualityManager?.stop();
        if (this.browser) {
            try { await this.browser.close(); } catch (e) {}
            this.browser = null;
            this.page = null;
        }
        if (this.ffmpegProcess) {
            this.ffmpegProcess.stdin?.end();
            this.ffmpegProcess.kill();
            this.ffmpegProcess = null;
        }
    }

    public isActive(): boolean {
        return this.browser !== null;
    }
}