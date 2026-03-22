import * as timersPromises from "timers/promises";
import logger from "../../../common/logger.js";
import { DownloadsManager } from "../../state/downloadsManager.js";
import { ScTargetManager, ScTarget } from "./targetManager.js";
import { ScClient } from "../api/scClient.js";
import { StreamSession, SessionResult } from "../../download/streamSession.js";
import { RetryCooldown } from "../../common/retryCooldown.js";
import { SC_POLL_MS } from "../../../common/timing.js";

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
            if (this.downloadsManager.hasStreamer(target.username)) continue;
            if (this.cooldown.isActive(target.username)) continue;

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

            if (this.downloadsManager.hasStreamer(target.username)) continue;

            if (this.cooldown.wasRecentlyCleared(target.username)) {
                logger.info(`[SC] ${target.username}: live again after cooldown`);
            }

            const streamName = await this.scClient.refreshStreamName(target.username);
            if (!streamName) {
                logger.info(`[SC] ${target.username}: refreshStreamName failed, falling back to roomId=${target.roomId}`);
            }

            const masterUrl = this.scClient.buildMasterUrl(streamName || target.roomId);

            logger.info(`[SC] ${target.username} is PUBLIC. Starting download...`);

            const handle = this.downloadsManager.add(masterUrl, {
                streamerId: target.username,
                alias: target.username,
            });

            if (handle) {
                const session = new StreamSession(target.username, target.username, handle, this.scClient);
                const completion = session.run(masterUrl).then((result: SessionResult) => {
                    if (!result.aborted && result.totalSegments === 0) {
                        logger.warn(`[SC] ${target.username}: session ended with 0 segments — cooldown`);
                        this.cooldown.recordFailure(target.username);
                    } else if (result.totalSegments > 0) {
                        logger.info(`[SC] ${target.username}: session completed (${result.totalSegments} segments)`);
                        this.cooldown.clear(target.username);
                    }
                }).catch((err: Error) => {
                    logger.error(`[SC] ${target.username}: unhandled session error`, { error: err.message });
                    handle.remove();
                    this.cooldown.recordFailure(target.username);
                });
                this.downloadsManager.registerDownloader(masterUrl, () => session.abort(), completion);
            }
        }
    }
}
