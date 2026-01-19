import * as timersPromises from "timers/promises";
import logger from "../../../common/logger.js";
import { DownloadsManager } from "../../state/downloadsManager.js";
import { TargetManager } from "./targetManager.js";
import { Fc2Client } from "../api/fc2Client.js";
import { StreamDownloader } from "../../download/streamDownloader.js";

export class Fc2DiscoveryService {
    private targetManager: TargetManager;
    private fc2Client: Fc2Client;
    private downloadsManager: DownloadsManager;
    private queueIndex: number = 0;

    constructor(targetManager: TargetManager, fc2Client: Fc2Client, downloadsManager: DownloadsManager) {
        this.targetManager = targetManager;
        this.fc2Client = fc2Client;
        this.downloadsManager = downloadsManager;
        logger.info("Fc2DiscoveryService initialized.");
    }

    public start(): void {
        const runLoop = async () => {
            while (true) {
                await this.processNextTarget();
                // Rate limit: 1 check per second
                await timersPromises.setTimeout(1000);
            }
        };
        void runLoop();
    }

    private async processNextTarget(): Promise<void> {
        const targets = this.targetManager.getTargets();

        if (targets.length === 0) {
            return;
        }

        // Round-robin selection
        if (this.queueIndex >= targets.length) {
            this.queueIndex = 0;
        }
        const channelId = targets[this.queueIndex];
        this.queueIndex++;

        // Skip if already downloading
        // Note: FC2 HLS URLs change, so we key by the channel ID for now if possible,
        // but DownloadsManager uses URL as key. We will handle this mapping better
        // when we have the real URL. for now, we just check if the ID is online.

        try {
            const isLive = await this.fc2Client.isOnline(channelId);

            if (isLive) {
                // TODO: When isOnline is implemented, it should return the masterPlaylistUrl
                // For now, this block is unreachable due to the mock returning false.
                logger.info(`FC2 Channel ${channelId} is LIVE! (Mock logic hit)`);

                /*
                // Implementation Logic for next step:
                const masterUrl = ...;
                if (!this.downloadsManager.has(masterUrl)) {
                     const handle = this.downloadsManager.add(masterUrl, {
                        streamerId: channelId,
                        alias: channelId // FC2 doesn't have aliases yet
                     });
                     if (handle) {
                         const downloader = new StreamDownloader(handle, this.fc2Client);
                         void downloader.start();
                     }
                }
                */
            }
        } catch (error: any) {
            logger.error(`Error checking status for FC2 channel ${channelId}`, { error: error.message });
        }
    }
}