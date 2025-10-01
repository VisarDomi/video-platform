// src/grower/liveGrowerService.ts
import * as fsPromises from "fs/promises";
import * as path from "path";
import * as timersPromises from "timers/promises";
import * as childProcess from "child_process";

import * as config from "../common/config.js";
import logger from "../common/logger.js";
import * as interfaces from "../common/interfaces.js";

interface LiveStatus {
    downloads: (interfaces.Download & { masterPlaylistUrl: string })[];
    lastUpdated: string;
}

export class GrowerService {
    private statusFilePath: string;
    private pollInterval: number = 2000; // Poll status file every 2 seconds
    private activeStitchers: Map<string, AbortController> = new Map();

    constructor() {
        const cfg = config.getConfig();
        this.statusFilePath = path.join(cfg.sharedStatePath, cfg.fileNames.liveStatus);
    }
    
    public start() {
        logger.info(`Starting Grower Service. Watching status file: ${this.statusFilePath}`);
        this._pollStatusFile();
    }

    private async _pollStatusFile() {
        while (true) {
            try {
                const status = await this._readStatusFile();
                if (status) {
                    this._syncStitchers(status.downloads);
                }
            } catch (error) {
                logger.error("Error during status file poll/sync.", { error });
            }
            await timersPromises.setTimeout(this.pollInterval);
        }
    }

    private _syncStitchers(currentDownloads: LiveStatus["downloads"]) {
        const currentDownloadPaths = new Set(currentDownloads.map((d) => d.tsFilePath).filter(Boolean));

        // 1. Stop stitchers for downloads that are no longer active
        for (const [tsFilePath, controller] of this.activeStitchers.entries()) {
            if (!currentDownloadPaths.has(tsFilePath)) {
                logger.info(`Download for ${tsFilePath} is no longer active. Stopping grower.`);
                controller.abort();
                this.activeStitchers.delete(tsFilePath);
            }
        }

        // 2. Start stitchers for new downloads
        for (const download of currentDownloads) {
            if (download.tsFilePath && download.segmentsDirPath && !this.activeStitchers.has(download.tsFilePath)) {
                logger.info(`New active download detected: ${download.tsFilePath}. Starting grower.`);
                const controller = new AbortController();
                this.activeStitchers.set(download.tsFilePath, controller);
                this._stitchStream(download, controller.signal).catch((err) => {
                    logger.error(`Grower process for ${download.tsFilePath} failed.`, { error: err });
                    if (this.activeStitchers.get(download.tsFilePath!) === controller) {
                        this.activeStitchers.delete(download.tsFilePath!);
                    }
                });
            }
        }
    }

    private async _stitchStream(download: interfaces.Download, signal: AbortSignal) {
        const { tsFilePath, segmentsDirPath } = download;
        if (!tsFilePath || !segmentsDirPath) {
            logger.error("Cannot stitch stream, missing tsFilePath or segmentsDirPath.", { download });
            return;
        }

        const processedSegments = new Set<string>();
        const ffmpegProcess = childProcess.spawn("ffmpeg", [
            "-hide_banner",
            "-loglevel",
            "error",
            "-stats",
            "-fflags",
            "+genpts",
            "-i",
            "pipe:0",
            "-c",
            "copy",
            "-f",
            "mpegts",
            "-y",
            tsFilePath,
        ]);

        ffmpegProcess.stderr.on("data", (data) => logger.verbose(`ffmpeg-grower (${path.basename(tsFilePath)}): ${data.toString()}`));
        ffmpegProcess.on("error", (err) => logger.error(`Failed to start FFmpeg (grower) for ${tsFilePath}. Is ffmpeg installed?`, { error: err }));
        ffmpegProcess.stdin.on("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EPIPE") {
                logger.warn(`ffmpeg-grower (${tsFilePath}): Broken pipe. FFmpeg process likely closed prematurely.`);
            } else {
                logger.error(`ffmpeg-grower (${tsFilePath}): stdin stream error.`, { error: err });
            }
        });

        signal.addEventListener("abort", () => {
            logger.info(`Abort signal received for ${tsFilePath}. Finalizing video.`);
            if (!ffmpegProcess.stdin.destroyed) {
                ffmpegProcess.stdin.end();
            }
        });

        while (!signal.aborted) {
            try {
                const allFiles = await fsPromises.readdir(segmentsDirPath);
                const newSegments = allFiles.filter((file) => file.endsWith(".ts") && !processedSegments.has(file)).sort(); // Lexicographical sort is sufficient as filenames are sequential

                if (newSegments.length > 0) {
                    for (const segment of newSegments) {
                        if (signal.aborted) break;
                        const segmentPath = path.join(segmentsDirPath, segment);
                        try {
                            const segmentBuffer = await fsPromises.readFile(segmentPath);
                            if (!ffmpegProcess.stdin.writable) {
                                logger.warn(`FFmpeg stdin not writable for ${tsFilePath}, breaking loop.`);
                                break;
                            }
                            ffmpegProcess.stdin.write(segmentBuffer);
                            processedSegments.add(segment);
                        } catch (readError) {
                            logger.warn(`Could not read segment ${segmentPath}, will retry.`, { error: readError });
                        }
                    }
                }
            } catch (dirError) {
                logger.verbose(`Segments directory ${segmentsDirPath} not accessible yet, will retry.`);
            }
            await timersPromises.setTimeout(500); // Check for new segments every 500ms
        }

        await new Promise<void>((resolve) =>
            ffmpegProcess.on("close", (code) => {
                logger.info(`FFmpeg (grower) process for ${tsFilePath} finished with code ${code}.`);
                resolve();
            })
        );
    }

    private async _readStatusFile(): Promise<LiveStatus | null> {
        try {
            const data = await fsPromises.readFile(this.statusFilePath, "utf-8");
            return JSON.parse(data) as LiveStatus;
        } catch (error: any) {
            if (error.code !== "ENOENT") {
                logger.error("Failed to read or parse live-status.json", { error });
            }
            return null;
        }
    }
}
