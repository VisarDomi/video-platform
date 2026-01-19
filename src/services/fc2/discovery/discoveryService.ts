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
        logger.info("[FC2] DiscoveryService initialized.");
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

        // NOISE REDUCTION: Only info log if we actually try to start something
        // logger.info(`[FC2] Checking target: ${channelId}`);

        try {
            if (this.downloadsManager.hasStreamer(channelId)) {
                // NOISE REDUCTION: Removed debug log
                return;
            }

            // Only log checking at debug level now
            logger.debug(`[FC2] Checking status for ${channelId}`);
            const isLive = await this.fc2Client.isOnline(channelId);

            if (isLive) {
                if (this.downloadsManager.hasStreamer(channelId)) return;

                const masterUrl = await this.fc2Client.getHlsUrl(channelId);

                if (masterUrl) {
                    logger.info(`[FC2] Channel ${channelId} is LIVE. Starting download...`);

                    const handle = this.downloadsManager.add(masterUrl, {
                        streamerId: channelId,
                        alias: channelId
                    });

                    if (handle) {
                        const downloader = new StreamDownloader(handle, this.fc2Client);
                        void downloader.start();
                    }
                } else {
                    logger.warn(`[FC2] Channel ${channelId} is online but failed to retrieve HLS URL.`);
                }
            }
        } catch (error: any) {
            logger.error(`[FC2] Error checking status for channel ${channelId}`, { error: error.message });
        }
    }
}