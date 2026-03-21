import * as timersPromises from "timers/promises";
import logger from "../../../common/logger.js";
import { DownloadsManager } from "../../state/downloadsManager.js";
import { TargetManager } from "../../common/targetManager.js";
import { ScClient } from "../api/scClient.js";
import { StreamDownloader, DownloadResult } from "../../download/streamDownloader.js";
import { RetryCooldown } from "../../common/retryCooldown.js";

const POLL_INTERVAL = 5_000;

export class ScDiscoveryService {
    private targetManager: TargetManager;
    private scClient: ScClient;
    private downloadsManager: DownloadsManager;
    private cooldown = new RetryCooldown("SC");

    constructor(targetManager: TargetManager, scClient: ScClient, downloadsManager: DownloadsManager) {
        this.targetManager = targetManager;
        this.scClient = scClient;
        this.downloadsManager = downloadsManager;
        logger.debug("[SC] DiscoveryService initialized (native mode).");
    }

    public start(): void {
        const runLoop = async () => {
            while (true) {
                try {
                    await this.poll();
                } catch (error: any) {
                    logger.error("[SC] Poll error", { error: error.message });
                }
                await timersPromises.setTimeout(POLL_INTERVAL);
            }
        };
        void runLoop();
    }

    private async poll(): Promise<void> {
        const targets = this.targetManager.getTargets();
        if (targets.length === 0) return;

        const roomIdMap = new Map<string, string>();
        const roomIds: string[] = [];

        for (const username of targets) {
            if (this.downloadsManager.hasStreamer(username)) continue;
            if (this.cooldown.isActive(username)) continue;

            const roomId = await this.scClient.resolveRoomId(username);
            if (!roomId) {
                logger.debug(`[SC] Could not resolve room ID for ${username}`);
                continue;
            }
            roomIdMap.set(roomId, username);
            roomIds.push(roomId);
        }

        if (roomIds.length === 0) return;

        const statuses = await this.scClient.checkStatusBulk(roomIds);

        for (const [roomId, statusInfo] of statuses) {
            const username = roomIdMap.get(roomId);
            if (!username) continue;

            if (statusInfo.status !== "public" || !statusInfo.isOnline) continue;

            if (this.downloadsManager.hasStreamer(username)) continue;

            const streamName = await this.scClient.refreshStreamName(username);
            if (!streamName) {
                this.cooldown.recordFailure(username);
                continue;
            }

            const masterUrl = this.scClient.buildMasterUrl(streamName);

            logger.info(`[SC] ${username} is PUBLIC. Starting download...`);
            this.cooldown.clear(username);

            const handle = this.downloadsManager.add(masterUrl, {
                streamerId: username,
                alias: username,
            });

            if (handle) {
                const downloader = new StreamDownloader(handle, this.scClient);
                downloader.start().then((result: DownloadResult) => {
                    if (result.exitReason === "error") {
                        this.cooldown.recordFailure(username);
                    }
                }).catch((err: Error) => {
                    logger.error(`[SC] ${username}: unhandled download error`, { error: err.message });
                    handle.remove();
                    this.cooldown.recordFailure(username);
                });
            }
        }
    }
}
