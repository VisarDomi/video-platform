import * as timersPromises from "timers/promises";
import logger from "../../../common/logger.js";
import { DownloadsManager } from "../../state/downloadsManager.js";
import { TargetManager } from "../../common/targetManager.js";
import { ScClient } from "../api/scClient.js";
import { StreamDownloader } from "../../download/streamDownloader.js";

const POLL_INTERVAL = 5_000;

/**
 * Tracks per-streamer failure state to prevent infinite retry loops.
 * When a download fails (e.g. empty streamName from API), the streamer
 * enters a cooldown period with exponential backoff before being retried.
 *
 * Ownership: ScDiscoveryService owns this — one instance per streamer.
 * The cooldown is cleared when a download succeeds (streamer goes online→offline→online).
 */
interface FailureCooldown {
    failCount: number;
    cooldownUntil: number; // Date.now() timestamp
}

const INITIAL_COOLDOWN_MS = 30_000;    // 30s after first failure
const MAX_COOLDOWN_MS = 10 * 60_000;   // 10 minutes cap

export class ScDiscoveryService {
    private targetManager: TargetManager;
    private scClient: ScClient;
    private downloadsManager: DownloadsManager;
    private failureCooldowns = new Map<string, FailureCooldown>();

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

    private recordFailure(username: string): void {
        const existing = this.failureCooldowns.get(username);
        const failCount = (existing?.failCount ?? 0) + 1;
        const cooldownMs = Math.min(INITIAL_COOLDOWN_MS * Math.pow(2, failCount - 1), MAX_COOLDOWN_MS);
        this.failureCooldowns.set(username, {
            failCount,
            cooldownUntil: Date.now() + cooldownMs,
        });
        logger.warn(`[SC] ${username}: download setup failed (attempt ${failCount}). Cooldown ${(cooldownMs / 1000).toFixed(0)}s`);
    }

    private clearFailure(username: string): void {
        this.failureCooldowns.delete(username);
    }

    private isInCooldown(username: string): boolean {
        const cd = this.failureCooldowns.get(username);
        if (!cd) return false;
        if (Date.now() >= cd.cooldownUntil) return false; // cooldown expired
        return true;
    }

    private async poll(): Promise<void> {
        const targets = this.targetManager.getTargets();
        if (targets.length === 0) return;

        // Resolve room IDs for all targets (lazy, cached in scClient)
        const roomIdMap = new Map<string, string>(); // roomId -> username
        const roomIds: string[] = [];

        for (const username of targets) {
            if (this.downloadsManager.hasStreamer(username)) continue;
            if (this.isInCooldown(username)) continue;

            const roomId = await this.scClient.resolveRoomId(username);
            if (!roomId) {
                logger.debug(`[SC] Could not resolve room ID for ${username}`);
                continue;
            }
            roomIdMap.set(roomId, username);
            roomIds.push(roomId);
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

            // Fresh API call to get current streamName (like StreaMonitor's getVideoUrl → getStatus)
            const streamName = await this.scClient.refreshStreamName(username);
            if (!streamName) {
                this.recordFailure(username);
                continue;
            }

            const masterUrl = this.scClient.buildMasterUrl(streamName);

            logger.info(`[SC] ${username} is PUBLIC. Starting download...`);
            this.clearFailure(username);

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
