import { chromium, Browser, Page } from "playwright";
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import logger from "../../../common/logger.js";

export class ScPageController {
    private browser: Browser | null = null;
    private page: Page | null = null;
    public readonly channelName: string;

    // FFmpeg State
    private ffmpegProcess: ChildProcess | null = null;
    public readonly tempDir: string;

    constructor(channelName: string) {
        this.channelName = channelName;
        this.tempDir = path.join(os.tmpdir(), `sc_capture_${channelName}`);
    }

    public async start(): Promise<void> {
        logger.info(`[SC] [${this.channelName}] Launching browser + FFmpeg...`);

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

        this.ffmpegProcess.stderr?.on("data", (data) => {
            // logger.debug(`[FFmpeg] ${data.toString()}`);
        });

        this.ffmpegProcess.on("exit", (code) => {
            if (code !== 0 && code !== null) {
                logger.error(`[SC] FFmpeg exited with code ${code}`);
            }
        });

        try {
            // UPDATED: Use system Chromium
            this.browser = await chromium.launch({
                executablePath: "/usr/bin/chromium", // <--- Force system browser
                headless: true, // Try headless "new" logic if possible, or set false if needed
                args: [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--mute-audio",
                    "--window-size=1280,720",
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
                if (this.ffmpegProcess && this.ffmpegProcess.stdin && !this.ffmpegProcess.stdin.destroyed) {
                    try {
                        const buf = Buffer.from(base64Data, "base64");
                        this.ffmpegProcess.stdin.write(buf);
                    } catch (e) {
                        // Ignore write errors if FFmpeg died
                    }
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
                        if (!stream) return false;

                        // Strict H.264 Requirement
                        const mimeType = 'video/webm;codecs=h264';
                        if (!MediaRecorder.isTypeSupported(mimeType)) {
                            console.error("[SC] Browser does not support H.264 recording!");
                            return false;
                        }

                        const mediaRecorder = new MediaRecorder(stream, { mimeType });
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

                        mediaRecorder.start(1000);
                        console.log(`[Recorder] Started with ${mimeType}`);
                        return true;

                    } catch (e) {
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