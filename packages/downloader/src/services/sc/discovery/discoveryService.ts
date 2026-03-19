import * as timersPromises from "timers/promises";
import logger from "../../../common/logger.js";
import { DownloadsManager } from "../../state/downloadsManager.js";
import { TargetManager } from "../../common/targetManager.js";
import { ScClient } from "../api/scClient.js";
import { StreamDownloader } from "../../download/streamDownloader.js";

const POLL_INTERVAL = 5_000;
const PRIVATE_STATUSES = new Set(["private", "groupShow", "p2p", "virtualPrivate", "p2pVoice"]);

export class ScDiscoveryService {
    private targetManager: TargetManager;
    private scClient: ScClient;
    private downloadsManager: DownloadsManager;

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

        // Resolve room IDs for all targets (lazy, cached in scClient)
        const roomIdMap = new Map<string, string>(); // roomId -> username
        const roomIds: string[] = [];

        for (const username of targets) {
            if (this.downloadsManager.hasStreamer(username)) continue;

            const info = await this.scClient.resolveRoomId(username);
            if (!info) {
                logger.debug(`[SC] Could not resolve room ID for ${username}`);
                continue;
            }
            roomIdMap.set(info.roomId, username);
            roomIds.push(info.roomId);
        }

        if (roomIds.length === 0) return;

        // Bulk status check
        const statuses = await this.scClient.checkStatusBulk(roomIds);

        for (const [roomId, statusInfo] of statuses) {
            const username = roomIdMap.get(roomId);
            if (!username) continue;

            if (statusInfo.status !== "public" || !statusInfo.isOnline) continue;

            // Double-check not already downloading (race with previous iteration)
            if (this.downloadsManager.hasStreamer(username)) continue;

            const roomInfo = await this.scClient.resolveRoomId(username);
            if (!roomInfo) continue;

            const masterUrl = this.scClient.buildMasterUrl(roomInfo.streamName);

            logger.info(`[SC] ${username} is PUBLIC. Starting download...`);

            const handle = this.downloadsManager.add(masterUrl, {
                streamerId: username,
                alias: username,
            });

            if (handle) {
                const downloader = new StreamDownloader(handle, this.scClient);
                void downloader.start();
            }
        }
    }
}
