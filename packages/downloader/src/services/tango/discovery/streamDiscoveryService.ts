import * as timersPromises from "timers/promises";

import logger from "../../../common/logger.js";
import { TANGO_POLL_MS } from "../../../common/timing.js";
import { DownloadsManager } from "../../state/downloadsManager.js";
import { ApiClient } from "../api/apiClient.js";
import { TangoTargetManager } from "./targetManager.js";
import { RetryCooldown } from "../../common/retryCooldown.js";
import { startStreamSession } from "../../common/sessionStarter.js";

export class StreamDiscoveryService {
    private readonly apiClient: ApiClient;
    private readonly targetManager: TangoTargetManager;
    private downloadsManager: DownloadsManager;
    private cooldown = new RetryCooldown("Tango");
    private lastLookupSummary: string | null = null;
    private lastDecisionByTarget = new Map<string, string>();

    constructor(apiClient: ApiClient, targetManager: TangoTargetManager, downloadsManager: DownloadsManager) {
        this.apiClient = apiClient;
        this.targetManager = targetManager;
        this.downloadsManager = downloadsManager;
        logger.debug("[Tango] StreamDiscoveryService initialized.");
    }

    private logDecision(targetId: string, alias: string, decision: string): void {
        if (this.lastDecisionByTarget.get(targetId) === decision) {
            return;
        }
        this.lastDecisionByTarget.set(targetId, decision);
        logger.info(`[Tango] Target ${alias} (${targetId}): ${decision}`);
    }

    public async start(): Promise<void> {
        let lastKnownTotal = -1;

        while (true) {
            const targets = this.targetManager.getTargets();
            const result = await this.apiClient.getLiveStreamsByAccountIds(targets.map(target => target.accountId));

            const currentTotal = this.downloadsManager.size;
            if (currentTotal !== lastKnownTotal) {
                logger.info(`[Tango] Watching for streams... Total active/pending: ${currentTotal}`);
                lastKnownTotal = currentTotal;
            }

            if (result) {
                const lookupSummary = `configuredTargets=${targets.length} livePublicTargets=${result.live.size}`;
                if (this.lastLookupSummary !== lookupSummary) {
                    logger.info(`[Tango] Account lookup summary: ${lookupSummary}`);
                    this.lastLookupSummary = lookupSummary;
                }

                for (const target of targets) {
                    const streamerId = target.accountId;
                    const alias = target.alias;
                    const stream = result.live.get(streamerId);

                    if (!stream) {
                        const rejection = result.rejected.get(streamerId);
                        if (rejection) {
                            this.logDecision(streamerId, alias, `not live/public (${rejection.kind}, ${rejection.status})`);
                        } else {
                            this.logDecision(streamerId, alias, "not live/public (offline)");
                        }
                        continue;
                    }

                    const masterPlaylistUrl = stream.masterPlaylistUrl;
                    if (this.downloadsManager.has(masterPlaylistUrl)) {
                        this.logDecision(streamerId, alias, "already downloading this playlistUrl");
                        continue;
                    }

                    if (this.downloadsManager.hasStreamer(streamerId)) {
                        this.logDecision(streamerId, alias, "already downloading this streamer");
                        continue;
                    }

                    if (this.cooldown.isActive(streamerId)) {
                        const remainingMs = this.cooldown.getRemainingMs(streamerId);
                        this.logDecision(streamerId, alias, `in cooldown (${Math.ceil(remainingMs / 1000)}s remaining)`);
                        continue;
                    }

                    logger.info(`[Tango] Discovered new stream from ${alias}.`);
                    this.logDecision(streamerId, alias, "public live stream found by account lookup; starting");

                    startStreamSession("Tango", {
                        streamerId: streamerId,
                        alias: alias,
                        masterPlaylistUrl,
                    }, this.apiClient, this.downloadsManager, this.cooldown);
                }
            } else {
                logger.verbose("[Tango] Poll complete: unable to fetch account stream lookup.");
            }
            await timersPromises.setTimeout(TANGO_POLL_MS);
        }
    }
}
