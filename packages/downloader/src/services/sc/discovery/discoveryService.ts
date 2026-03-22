import * as timersPromises from "timers/promises";
import logger from "../../../common/logger.js";
import { DownloadsManager } from "../../state/downloadsManager.js";
import { ScTargetManager, ScTarget } from "./targetManager.js";
import { ScClient } from "../api/scClient.js";
import { StreamDownloader, DownloadResult } from "../../download/streamDownloader.js";
import { RetryCooldown } from "../../common/retryCooldown.js";

const POLL_INTERVAL = 5_000;

export class ScDiscoveryService {
    private targetManager: ScTargetManager;
    private scClient: ScClient;
    private downloadsManager: DownloadsManager;
    private cooldown = new RetryCooldown("SC");

    constructor(targetManager: ScTargetManager, scClient: ScClient, downloadsManager: DownloadsManager) {
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

        // Build the bulk check list using roomIds directly from the file.
        // No per-target API calls — roomIds are resolved at add-time by the server.
        const roomIdMap = new Map<string, ScTarget>();
        const roomIds: string[] = [];

        for (const target of targets) {
            if (this.downloadsManager.hasStreamer(target.username)) continue;
            if (this.cooldown.isActive(target.username)) continue;

            if (!target.roomId) {
                // Legacy entry without roomId — skip.
                // User should re-add via API to resolve.
                continue;
            }

            roomIdMap.set(target.roomId, target);
            roomIds.push(target.roomId);
        }

        if (roomIds.length === 0) return;

        const statuses = await this.scClient.checkStatusBulk(roomIds);

        for (const [roomId, statusInfo] of statuses) {
            const target = roomIdMap.get(roomId);
            if (!target) continue;

            if (statusInfo.status !== "public" || !statusInfo.isLive) continue;

            if (this.downloadsManager.hasStreamer(target.username)) continue;

            const streamName = await this.scClient.refreshStreamName(target.username);
            if (!streamName) {
                // Username might be stale (renamed). Fall back to roomId as streamName.
                logger.info(`[SC] ${target.username}: refreshStreamName failed, falling back to roomId=${target.roomId}`);
            }

            const masterUrl = this.scClient.buildMasterUrl(streamName || target.roomId);

            logger.info(`[SC] ${target.username} is PUBLIC. Starting download...`);

            const handle = this.downloadsManager.add(masterUrl, {
                streamerId: target.username,
                alias: target.username,
            });

            if (handle) {
                const downloader = new StreamDownloader(handle, this.scClient);
                downloader.start().then((result: DownloadResult) => {
                    if (!result.aborted && result.segmentCount === 0) {
                        logger.warn(`[SC] ${target.username}: download ended with 0 segments — cooldown`);
                        this.cooldown.recordFailure(target.username);
                    } else if (result.segmentCount > 0) {
                        logger.info(`[SC] ${target.username}: download completed (${result.segmentCount} segments)`);
                        this.cooldown.clear(target.username);
                    }
                }).catch((err: Error) => {
                    logger.error(`[SC] ${target.username}: unhandled download error`, { error: err.message });
                    handle.remove();
                    this.cooldown.recordFailure(target.username);
                });
            }
        }
    }
}
