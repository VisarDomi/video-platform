import * as timersPromises from "timers/promises";
import type { LiveCapture, Logger, Target } from "sdk";

import { DownloadsManager } from "../state/downloadsManager.js";
import { ActiveRecordingReconciler } from "./activeRecordingReconciler.js";
import { RetryCooldown } from "./retryCooldown.js";
import { startStreamSession } from "./sessionStarter.js";

export interface DiscoverySite {
    // The site ID: it names the recording folders and keys the running sessions.
    id: string;
    // The display name, the prefix of the core's own lines about this site.
    label: string;
    // The site's logger ("[<label>] ...").
    log: Logger;
}

// The listed targets, as of now (the list may change between two calls).
export interface TargetSource {
    getTargets(): Target[];
    hasTarget(id: string): boolean;
}

// One site's discovery: every poll reads the download list, ends the sessions of removed
// targets, asks the site who is live, reconciles that answer with the recordings on disk,
// and starts a capture for each live target that has none. The site supplies only the
// lookup and its cadence (LiveCapture); every rule about sessions is here:
//
// - A target removed from the list ends its session at once, even while lookups fail.
// - A failed lookup (null) changes nothing: no capture ends because the site was down.
// - A recording ends on "offline" only after two observations at least 60 s apart
//   without media progress (ActiveRecordingReconciler).
// - A new recording identity for a target replaces its running session, also one that
//   has no folder on disk yet.
// - A target whose capture ended with no media waits out a cooldown before it restarts.
export class DiscoveryLoop {
    private readonly cooldown: RetryCooldown;
    private activeReconciler: ActiveRecordingReconciler;
    private readonly lastDecisionByTarget = new Map<string, string>();
    private previousTargetIds = new Set<string>();
    private lastKnownTotal = -1;
    private lastLookupSummary: string | null = null;

    constructor(
        private readonly site: DiscoverySite,
        private readonly capture: LiveCapture,
        private readonly targets: TargetSource,
        private readonly downloadsManager: DownloadsManager,
    ) {
        this.cooldown = new RetryCooldown(site.label);
        this.activeReconciler = new ActiveRecordingReconciler(
            site.id,
            downloadsManager,
            (alias) => this.targetIdForFolderAlias(alias),
        );
        this.site.log.debug("DiscoveryService initialized.");
    }

    // Runs until the process ends. A poll that throws is logged and the next one runs on
    // schedule.
    public async start(): Promise<void> {
        await this.activeReconciler.recoverLocalState();
        while (true) {
            const pollStartedAt = Date.now();
            try {
                await this.poll();
            } catch (error: any) {
                this.site.log.error("Poll error", { error: error?.message ?? String(error) });
            }
            const interval = this.capture.pollIntervalMs;
            await timersPromises.setTimeout(this.capture.pollFromStart
                ? Math.max(0, interval - (Date.now() - pollStartedAt))
                : interval);
        }
    }

    public async poll(): Promise<void> {
        const targets = this.targets.getTargets();
        const targetIds = new Set(targets.map((target) => target.id));
        // List removals apply even when the remote lookup is unavailable.
        await this.activeReconciler.endRemovedSessions(targetIds);
        for (const id of this.previousTargetIds) {
            if (!targetIds.has(id)) this.lastDecisionByTarget.delete(id);
        }
        this.previousTargetIds = targetIds;

        const snapshot = await this.capture.lookup(targets, {
            recordingId: (targetId) => this.downloadsManager.getRecordingId(targetId, this.site.id),
        });

        const currentTotal = this.downloadsManager.size;
        if (currentTotal !== this.lastKnownTotal) {
            this.site.log.debug(`Watching for streams... Total active/pending: ${currentTotal}`);
            this.lastKnownTotal = currentTotal;
        }
        if (!snapshot) return;

        const { resumePaths } = await this.activeReconciler.reconcile(snapshot);
        const lookupSummary = `configuredTargets=${targets.length} livePublicTargets=${snapshot.live.size}`;
        if (this.lastLookupSummary !== lookupSummary) {
            this.site.log.debug(`Lookup summary: ${lookupSummary}`);
            this.lastLookupSummary = lookupSummary;
        }

        for (const target of targets) {
            const targetId = target.id;
            // The list may have changed while the lookup was in flight.
            if (!this.targets.hasTarget(targetId)) continue;
            const stream = snapshot.live.get(targetId);
            if (!stream) {
                this.logDecision(target, "not live/public");
                continue;
            }
            if (!stream.recordingId) {
                this.logDecision(target, "live stream has no recording identity; refusing unsafe capture");
                continue;
            }

            // Only this site's capture of the target: another site may list the same ID.
            const activeRecordingId = this.downloadsManager.getRecordingId(targetId, this.site.id);
            if (activeRecordingId && activeRecordingId !== stream.recordingId) {
                // Empty/missing folders are invisible to disk reconciliation.
                await this.downloadsManager.finalizeStreamer(targetId, "a new stream replaced it");
                this.cooldown.clear(targetId);
            }
            if (this.downloadsManager.hasStreamer(targetId)) {
                this.logDecision(target, "already downloading this streamer");
                continue;
            }
            if (stream.masterPlaylistUrl && this.downloadsManager.has(stream.masterPlaylistUrl)) {
                this.logDecision(target, "already downloading this playlistUrl");
                continue;
            }
            if (this.cooldown.isActive(targetId)) {
                const remainingMs = this.cooldown.getRemainingMs(targetId);
                this.logDecision(target, `in cooldown (${Math.ceil(remainingMs / 1000)}s remaining)`);
                continue;
            }
            if (this.cooldown.wasRecentlyCleared(targetId)) {
                this.site.log.debug(`${target.label} (${targetId}): live again after cooldown`);
            }

            const start = this.capture.resolveMaster ? await this.capture.resolveMaster(stream) : stream;
            if (!start) continue;

            this.site.log.debug(`Discovered new stream from ${start.alias}.`);
            this.logDecision(target, "live stream found by lookup; starting");
            startStreamSession(this.site.label, {
                streamerId: targetId,
                alias: start.alias,
                recordingId: start.recordingId,
                masterPlaylistUrl: start.masterPlaylistUrl,
                existingDirPath: resumePaths.get(targetId),
            }, this.capture.provider, this.downloadsManager, this.cooldown);
        }
    }

    private targetIdForFolderAlias(alias: string): string | null {
        const targets = this.targets.getTargets();
        if (this.capture.targetIdForFolderAlias) return this.capture.targetIdForFolderAlias(alias, targets);
        return targets.find((target) => target.label === alias)?.id ?? null;
    }

    private logDecision(target: Target, decision: string): void {
        if (this.lastDecisionByTarget.get(target.id) === decision) return;
        this.lastDecisionByTarget.set(target.id, decision);
        this.site.log.debug(`Target ${target.label} (${target.id}): ${decision}`);
    }
}
