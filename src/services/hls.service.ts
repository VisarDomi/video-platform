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
        // Step 1: Get a definitive snapshot of live streams AT THIS MOMENT.
        // This is the "do not touch" list for the recovery phase.
        const liveStatus = await livestreamService.readLiveStatus();
        const liveFolders = new Set(liveStatus?.downloads.map((d) => path.basename(d.segmentsDirPath)) ?? []);
        if (liveFolders.size > 0) {
            logger.info(`Found ${liveFolders.size} active live streams. They will be ignored during recovery.`);
        }

        // Step 2: Recover interrupted streams, IGNORING the ones that are currently live.
        await this.recoverInterruptedStreams(liveFolders);

        // Step 3: Process the VOD backlog. This method now has its own internal live-checking
        // and will WAIT here until the entire queue is drained before proceeding.
        await vodService.processBacklog();

        // Step 4: ONLY after all historical work is done, begin monitoring for live streams.
        livestreamService.startMonitoring();

        logger.info("HLS service initialization complete. System is now in live monitoring mode.");
    }

    private async recoverInterruptedStreams(liveFolders: Set<string>): Promise<void> {
        logger.info("Starting recovery scan for interrupted streams...");
        let recoveryCount = 0;

        for (const { path: dirPath } of ALL_VIDEO_PATHS) {
            try {
                const entries = await fs.readdir(dirPath, { withFileTypes: true });
                for (const entry of entries) {
                    // CRITICAL FIX: If the directory is in our live list, skip it entirely.
                    if (entry.isDirectory() && !liveFolders.has(entry.name)) {
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
