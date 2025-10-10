// src/services/hls.service.ts
import { promises as fs } from "fs";
import path from "path";
import { ALL_VIDEO_PATHS } from "../config.js";
import logger from "../logger.js";
import { vodService } from "./vod.service.js";
import { livestreamService } from "./livestream.service.js";

const PLAYLIST_FILENAME = "playlist.m3u8";
const ENDLIST_TAG = "#EXT-X-ENDLIST";

class HlsService {
    public initialize(): void {
        // Fire-and-forget the startup sequence so the server can start immediately.
        this._runStartupSequence().catch((err) => {
            logger.error("HLS startup sequence failed to launch.", { error: err });
        });
    }

    private async _runStartupSequence(): Promise<void> {
        await this.recoverInterruptedStreams();

        // Fire-and-forget the backlog processing. It will now internally
        // and continuously check for live streams before processing any folder.
        void vodService.processBacklog();

        // Begin monitoring for live stream updates immediately.
        livestreamService.startMonitoring();

        logger.info("HLS service initialization complete.");
    }

    private async recoverInterruptedStreams(): Promise<void> {
        logger.info("Starting recovery scan for interrupted streams...");
        let recoveryCount = 0;

        for (const { path: dirPath } of ALL_VIDEO_PATHS) {
            try {
                const entries = await fs.readdir(dirPath, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        const videoFolderPath = path.join(dirPath, entry.name);
                        const playlistPath = path.join(videoFolderPath, PLAYLIST_FILENAME);
                        try {
                            const content = await fs.readFile(playlistPath, "utf-8");
                            if (!content.trim().endsWith(ENDLIST_TAG)) {
                                await fs.appendFile(playlistPath, `\n${ENDLIST_TAG}\n`);
                                logger.info(`Recovered interrupted stream: ${entry.name}`);
                                recoveryCount++;
                            }
                        } catch (err: any) {
                            if (err.code !== "ENOENT") {
                                logger.warn(`Could not process playlist for recovery in ${entry.name}`, { error: err });
                            }
                        }
                    }
                }
            } catch (err) {
                logger.error(`Failed to scan directory for recovery: ${dirPath}`, { error: err });
            }
        }
        logger.info(`Recovery scan complete. Finalized ${recoveryCount} streams.`);
    }
}

export const hlsService = new HlsService();
