import * as timersPromises from "timers/promises";
import logger from "../../../common/logger.js";
import { DownloadsManager } from "../../state/downloadsManager.js";
import { ScTargetManager, ScTarget } from "./targetManager.js";
import { ScClient } from "../api/scClient.js";
import { RetryCooldown } from "../../common/retryCooldown.js";
import { SC_IDENTITY_REFRESH_MS, SC_POLL_MS } from "../../../common/timing.js";
import { startStreamSession } from "../../common/sessionStarter.js";
import { ActiveRecordingReconciler } from "../../common/activeRecordingReconciler.js";
import type { ProviderSnapshot } from "../../common/providerSnapshot.js";

export class ScDiscoveryService {
    private targetManager: ScTargetManager;
    private scClient: ScClient;
    private downloadsManager: DownloadsManager;
    private cooldown = new RetryCooldown("SC");
    private readonly activeReconciler: ActiveRecordingReconciler;
    private readonly identityRefreshedAt = new Map<string, number>();

    constructor(targetManager: ScTargetManager, scClient: ScClient, downloadsManager: DownloadsManager) {
        this.targetManager = targetManager;
        this.scClient = scClient;
        this.downloadsManager = downloadsManager;
        this.activeReconciler = new ActiveRecordingReconciler(
            "sc",
            downloadsManager,
            (alias) => this.targetManager.getTargets().find((target) => target.username === alias)?.roomId ?? null,
        );
        logger.debug("[SC] DiscoveryService initialized (native mode).");
    }

    public start(): void {
        const runLoop = async () => {
            await this.activeReconciler.recoverLocalState();
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
            if (!target.roomId) {
                continue;
            }

            roomIdMap.set(target.roomId, target);
            roomIds.push(target.roomId);
        }

        if (roomIds.length === 0) return;

        const statuses = await this.scClient.checkStatusBulk(roomIds);
        if (!statuses) return;

        const snapshot: ProviderSnapshot = {
            observedAt: Date.now(),
            live: new Map(),
            terminalTargetIds: new Set(),
        };
        const resolvedTargets = new Map<string, Awaited<ReturnType<ScClient["refreshTarget"]>>>();
        for (const target of targets) {
            const status = statuses.get(target.roomId);
            if (status?.status === "public" && status.isLive) {
                let recordingId = this.downloadsManager.getRecordingId(target.roomId)
                    ?? this.scClient.getKnownRecordingId(target.roomId);
                const lastRefresh = this.identityRefreshedAt.get(target.roomId) ?? 0;
                if (!recordingId || Date.now() - lastRefresh >= SC_IDENTITY_REFRESH_MS) {
                    const refreshed = await this.scClient.refreshTarget(target.username);
                    this.identityRefreshedAt.set(target.roomId, Date.now());
                    resolvedTargets.set(target.roomId, refreshed);
                    recordingId = refreshed?.statusChangedAt || null;
                }
                if (!recordingId) continue;
                snapshot.live.set(target.roomId, {
                    targetId: target.roomId,
                    alias: target.username,
                    recordingId,
                    masterPlaylistUrl: "",
                });
            } else {
                snapshot.terminalTargetIds.add(target.roomId);
                this.identityRefreshedAt.delete(target.roomId);
            }
        }
        const { resumePaths } = await this.activeReconciler.reconcile(snapshot);

        for (const [roomId, statusInfo] of statuses) {
            const target = roomIdMap.get(roomId);
            if (!target) continue;

            if (statusInfo.status !== "public" || !statusInfo.isLive) continue;
            if (this.downloadsManager.hasStreamer(target.roomId)) continue;
            if (this.cooldown.isActive(target.roomId)) continue;

            if (this.cooldown.wasRecentlyCleared(target.roomId)) {
                logger.info(`[SC] ${target.username} (${target.roomId}): live again after cooldown`);
            }

            const refreshedTarget = resolvedTargets.get(target.roomId)
                ?? await this.scClient.refreshTarget(target.username);
            const currentAlias = refreshedTarget?.username ?? target.username;
            const streamName = refreshedTarget?.streamName ?? null;
            const recordingId = refreshedTarget?.statusChangedAt ?? this.scClient.getKnownRecordingId(target.roomId);
            if (!recordingId) {
                logger.warn(`[SC] ${currentAlias}: public stream has no statusChangedAt; refusing unsafe capture`);
                continue;
            }
            if (!streamName) {
                logger.info(`[SC] ${currentAlias}: refreshStreamName failed, falling back to roomId=${target.roomId}`);
            }

            const masterUrl = this.scClient.buildMasterUrl(streamName || target.roomId);

            logger.info(`[SC] ${currentAlias} is PUBLIC. Starting download...`);

            startStreamSession("SC", {
                streamerId: target.roomId,
                alias: currentAlias,
                recordingId,
                masterPlaylistUrl: masterUrl,
                existingDirPath: resumePaths.get(target.roomId),
            }, this.scClient, this.downloadsManager, this.cooldown);
        }
    }
}
