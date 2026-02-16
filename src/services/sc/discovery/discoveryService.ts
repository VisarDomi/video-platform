import * as timersPromises from "timers/promises";
import logger from "../../../common/logger.js";
import { DownloadsManager } from "../../state/downloadsManager.js";
import { TargetManager } from "../../common/targetManager.js";
import { ScClient } from "../api/scClient.js";
import { StreamDownloader } from "../../download/streamDownloader.js";

export class ScDiscoveryService {
    private targetManager: TargetManager;
    private scClient: ScClient;
    private downloadsManager: DownloadsManager;
    private queueIndex: number = 0;

    constructor(targetManager: TargetManager, scClient: ScClient, downloadsManager: DownloadsManager) {
        this.targetManager = targetManager;
        this.scClient = scClient;
        this.downloadsManager = downloadsManager;
        logger.debug("[SC] DiscoveryService initialized.");
    }

    public start(): void {
        const runLoop = async () => {
            while (true) {
                await this.processNextTarget();
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

        if (this.queueIndex >= targets.length) {
            this.queueIndex = 0;
        }
        const username = targets[this.queueIndex];
        this.queueIndex++;

        try {
            if (this.downloadsManager.hasStreamer(username)) {
                return;
            }

            const isLive = await this.scClient.isOnline(username);

            if (isLive) {
                if (this.downloadsManager.hasStreamer(username)) return;

                // getHlsUrl now triggers the browser sniffer
                const masterUrl = await this.scClient.getHlsUrl(username);

                if (masterUrl) {
                    logger.info(`[SC] Channel ${username} is LIVE. Starting download...`);

                    const handle = this.downloadsManager.add(masterUrl, {
                        streamerId: username,
                        alias: username
                    });

                    if (handle) {
                        const downloader = new StreamDownloader(handle, this.scClient);
                        void downloader.start();
                    }
                } else {
                    logger.warn(`[SC] Channel ${username} is online but failed to retrieve HLS URL.`);
                }
            }
        } catch (error: any) {
            logger.error(`[SC] Error checking status for channel ${username}`, { error: error.message });
        }
    }
}