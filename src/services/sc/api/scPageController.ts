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

    // FFmpeg State
    private ffmpegProcess: ChildProcess | null = null;
    public readonly tempDir: string;

    constructor(channelName: string) {
        this.channelName = channelName;
        this.tempDir = path.join(os.tmpdir(), `sc_capture_${channelName}`);
    }

    public async start(): Promise<void> {
        logger.info(`[SC] [${this.channelName}] Launching browser + FFmpeg (System Chromium)...`);

        // 1. Prepare Temp Dir
        try {
            await fs.rm(this.tempDir, { recursive: true, force: true });
            await fs.mkdir(this.tempDir, { recursive: true });
        } catch (e) {
            logger.error(`[SC] Failed to create temp dir ${this.tempDir}`);
            return;
        }

        // 2. Start FFmpeg (Hybrid: Copy Video, Transcode Audio -> HLS)
        this.ffmpegProcess = spawn("ffmpeg", [
            "-hide_banner",
            "-y",
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

        // DEBUG: Log FFmpeg Output
        this.ffmpegProcess.stderr?.on("data", (data) => {
            logger.debug(`[FFmpeg] ${data.toString()}`);
        });

        this.ffmpegProcess.on("exit", (code) => {
            if (code !== 0 && code !== null) {
                logger.error(`[SC] FFmpeg exited with code ${code}`);
            }
        });

        try {
            this.browser = await chromium.launch({
                executablePath: "/usr/bin/chromium",
                headless: false, // Keep visible for debugging
                args: [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--mute-audio",
                    "--window-size=1920,1080", // Increased size
                    "--enable-features=MediaRecorderInMP4"
                ],
            });

            const context = await this.browser.newContext({
                viewport: { width: 1920, height: 1080 }, // Increased size
                userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                permissions: ['microphone', 'camera']
            });

            this.page = await context.newPage();

            // DEBUG: Capture Browser Console
            this.page.on("console", msg => {
                logger.debug(`[Browser Console] ${msg.text()}`);
            });

            await this.page.exposeFunction("nodeOnChunk", (base64Data: string, seqId: number) => {
                if (this.ffmpegProcess && this.ffmpegProcess.stdin && !this.ffmpegProcess.stdin.destroyed) {
                    try {
                        const buf = Buffer.from(base64Data, "base64");
                        logger.debug(`[Node] Writing chunk #${seqId} to FFmpeg (Payload: ${base64Data.length} chars -> ${buf.length} bytes)`);
                        this.ffmpegProcess.stdin.write(buf);
                    } catch (e: any) {
                        logger.warn(`[SC] Failed to write chunk #${seqId} to FFmpeg stdin: ${e.message}`);
                    }
                } else {
                    logger.warn(`[Node] Dropping chunk #${seqId} because FFmpeg stdin is closed/destroyed.`);
                }
            });

            const targetUrl = `https://stripchat.com/${this.channelName}`;
            await this.page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

            try {
                const enterBtn = this.page.locator('.btn-visitors-agreement-accept').first();
                if (await enterBtn.isVisible({ timeout: 5000 })) {
                    await enterBtn.click();
                }
            } catch (e) {}

            await this.page.waitForTimeout(5000);

            // --- START QUALITY MANAGER ---
            this.qualityManager = new ScQualityManager(this.page);
            this.qualityManager.start();
            // -----------------------------

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
                        } else {
                            console.log(`Browser supports ${mimeType}`);
                        }

                        const mediaRecorder = new MediaRecorder(stream, { mimeType });
                        (window as any).__mediaRecorder = mediaRecorder;
                        (window as any).__isRecording = true;

                        // --- Queue System Start ---
                        const queue: { blob: Blob, seq: number }[] = [];
                        let isProcessing = false;
                        let seqCounter = 0;

                        const processQueue = async () => {
                            if (isProcessing) return;
                            isProcessing = true;

                            while (queue.length > 0) {
                                const item = queue.shift();
                                if (!item) continue;

                                console.log(`[Queue] Processing chunk #${item.seq} (Blob Size: ${item.blob.size})`);

                                await new Promise<void>((resolve) => {
                                    const reader = new FileReader();
                                    // Use ArrayBuffer to avoid MIME type comma parsing issues
                                    reader.readAsArrayBuffer(item.blob);

                                    reader.onloadend = async () => {
                                        if (reader.result instanceof ArrayBuffer) {
                                            const buffer = reader.result;
                                            const bytes = new Uint8Array(buffer);
                                            let binary = '';
                                            const len = bytes.byteLength;
                                            // Manual Base64 conversion to ensure integrity
                                            for (let i = 0; i < len; i++) {
                                                binary += String.fromCharCode(bytes[i]);
                                            }
                                            const base64 = window.btoa(binary);

                                            console.log(`[Queue] Sending chunk #${item.seq} to Node. Base64 Len: ${base64.length}`);
                                            await (window as any).nodeOnChunk(base64, item.seq);
                                        } else {
                                            console.error(`[Queue] Reader result was not ArrayBuffer for chunk #${item.seq}`);
                                        }
                                        resolve();
                                    };
                                    reader.onerror = () => {
                                        console.error(`[Queue] Reader error on chunk #${item.seq}`);
                                        resolve();
                                    };
                                });
                            }
                            isProcessing = false;
                        };

                        mediaRecorder.ondataavailable = (e) => {
                            if (e.data && e.data.size > 0) {
                                seqCounter++;
                                console.log(`[Recorder] Chunk received #${seqCounter} (Size: ${e.data.size}). Pushing to queue.`);
                                queue.push({ blob: e.data, seq: seqCounter });
                                processQueue();
                            }
                        };
                        // --- Queue System End ---

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

    public async stop(): Promise<void> {
        this.qualityManager?.stop(); // Stop the interval
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