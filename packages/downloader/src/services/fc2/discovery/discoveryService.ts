import * as timersPromises from "timers/promises";
import logger from "../../../common/logger.js";
import { DownloadsManager } from "../../state/downloadsManager.js";
import { TargetManager } from "../../common/targetManager.js";
import { Fc2Client } from "../api/fc2Client.js";
import { RetryCooldown } from "../../common/retryCooldown.js";
import { FC2_POLL_MS } from "../../../common/timing.js";
import { startStreamSession } from "../../common/sessionStarter.js";
import { ActiveRecordingReconciler } from "../../common/activeRecordingReconciler.js";
import type { ProviderSnapshot } from "../../common/providerSnapshot.js";

export class Fc2DiscoveryService {
    private targetManager: TargetManager;
    private fc2Client: Fc2Client;
    private downloadsManager: DownloadsManager;
    private cooldown = new RetryCooldown("FC2");
    private readonly activeReconciler: ActiveRecordingReconciler;

    constructor(targetManager: TargetManager, fc2Client: Fc2Client, downloadsManager: DownloadsManager) {
        this.targetManager = targetManager;
        this.fc2Client = fc2Client;
        this.downloadsManager = downloadsManager;
        this.activeReconciler = new ActiveRecordingReconciler(
            "fc2",
            downloadsManager,
            (alias) => this.targetManager.hasTarget(alias) ? alias : null,
        );
        logger.debug("[FC2] DiscoveryService initialized.");
    }

    public start(): void {
        const runLoop = async () => {
            await this.activeReconciler.recoverLocalState();
            while (true) {
                const requestStartedAt = Date.now();
                await this.poll();
                await timersPromises.setTimeout(Math.max(0, FC2_POLL_MS - (Date.now() - requestStartedAt)));
            }
        };
        void runLoop();
    }

    private async poll(): Promise<void> {
        const targets = this.targetManager.getTargets();

        if (targets.length === 0) {
            return;
        }

        try {
            const broadcasts = await this.fc2Client.getAdultChannelList();
            if (!broadcasts) return;
            const snapshot: ProviderSnapshot = {
                observedAt: Date.now(),
                live: new Map(),
                terminalTargetIds: new Set(),
            };
            for (const channelId of targets) {
                const broadcast = broadcasts.get(channelId);
                if (broadcast && !broadcast.isPaid) {
                    snapshot.live.set(channelId, {
                        targetId: channelId,
                        alias: channelId,
                        recordingId: broadcast.startTime,
                        masterPlaylistUrl: "",
                    });
                } else {
                    snapshot.terminalTargetIds.add(channelId);
                }
            }
            const { resumePaths } = await this.activeReconciler.reconcile(snapshot);

            for (const channelId of targets) {
                const broadcast = broadcasts.get(channelId);
                if (!broadcast || broadcast.isPaid) continue;
                if (this.downloadsManager.hasStreamer(channelId)) continue;
                if (this.cooldown.isActive(channelId)) continue;

                const masterUrl = await this.fc2Client.getHlsUrl(channelId);

                if (masterUrl) {
                    logger.info(`[FC2] Channel ${channelId} is LIVE. Starting download...`);

                    startStreamSession("FC2", {
                        streamerId: channelId,
                        alias: channelId,
                        recordingId: broadcast.startTime,
                        masterPlaylistUrl: masterUrl,
                        existingDirPath: resumePaths.get(channelId),
                    }, this.fc2Client, this.downloadsManager, this.cooldown);
                } else {
                    logger.warn(`[FC2] Channel ${channelId} is online but failed to retrieve HLS URL.`);
                }
            }
        } catch (error: any) {
            logger.error("[FC2] Error processing adult channel snapshot", { error: error.message });
        }
    }
}
