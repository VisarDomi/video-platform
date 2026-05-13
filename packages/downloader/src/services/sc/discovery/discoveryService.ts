import * as timersPromises from "timers/promises";
import logger from "../../../common/logger.js";
import { DownloadsManager } from "../../state/downloadsManager.js";
import { ScTargetManager, ScTarget } from "./targetManager.js";
import { ScClient } from "../api/scClient.js";
import { RetryCooldown } from "../../common/retryCooldown.js";
import { SC_POLL_MS } from "../../../common/timing.js";
import { startStreamSession } from "../../common/sessionStarter.js";

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
                await timersPromises.setTimeout(SC_POLL_MS);
            }
        };
        void runLoop();
    }

    private async poll(): Promise<void> {
        const targets = this.targetManager.getTargets();
        if (targets.length === 0) return;

        const roomIdMap = new Map<string, ScTarget>();
        const roomIds: string[] = [];

        for (const target of targets) {
            if (this.downloadsManager.hasStreamer(target.roomId)) continue;
            if (this.cooldown.isActive(target.roomId)) continue;

            if (!target.roomId) {
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

            if (this.downloadsManager.hasStreamer(target.roomId)) continue;

            if (this.cooldown.wasRecentlyCleared(target.roomId)) {
                logger.info(`[SC] ${target.username} (${target.roomId}): live again after cooldown`);
            }

            const refreshedTarget = await this.scClient.refreshTarget(target.username);
            const currentAlias = refreshedTarget?.username ?? target.username;
            const streamName = refreshedTarget?.streamName ?? null;
            if (!streamName) {
                logger.info(`[SC] ${currentAlias}: refreshStreamName failed, falling back to roomId=${target.roomId}`);
            }

            const masterUrl = this.scClient.buildMasterUrl(streamName || target.roomId);

            logger.info(`[SC] ${currentAlias} is PUBLIC. Starting download...`);

            startStreamSession("SC", {
                streamerId: target.roomId,
                alias: currentAlias,
                masterPlaylistUrl: masterUrl,
            }, this.scClient, this.downloadsManager, this.cooldown);
        }
    }
}
