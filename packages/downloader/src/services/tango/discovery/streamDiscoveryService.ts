import * as timersPromises from "timers/promises";

import logger from "../../../common/logger.js";
import { TANGO_POLL_MS } from "../../../common/timing.js";
import { StreamSession, SessionResult } from "../../download/streamSession.js";
import { DownloadsManager } from "../../state/downloadsManager.js";
import { ApiClient } from "../api/apiClient.js";
import { TangoTargetManager } from "./targetManager.js";
import { RetryCooldown } from "../../common/retryCooldown.js";

export class StreamDiscoveryService {
    private readonly apiClient: ApiClient;
    private readonly targetManager: TangoTargetManager;
    private downloadsManager: DownloadsManager;
    private cooldown = new RetryCooldown("Tango");
    private lastFeedSummary: string | null = null;
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
            const streamIdsResponseBody = await this.apiClient.getFollowingResponseBody();

            const currentTotal = this.downloadsManager.size;
            if (currentTotal !== lastKnownTotal) {
                logger.info(`[Tango] Watching for streams... Total active/pending: ${currentTotal}`);
                lastKnownTotal = currentTotal;
            }

            if (streamIdsResponseBody?.entities?.stream) {
                const streams = Object.values(streamIdsResponseBody.entities.stream) as any[];
                const streamByBroadcaster = new Map<string, any>();
                let publicWithPlaylist = 0;

                for (const stream of streams) {
                    const streamerId = stream?.broadcasterId as string | undefined;
                    if (!streamerId) continue;
                    streamByBroadcaster.set(streamerId, stream);
                    if (stream.kind === "PUBLIC" && stream.playlistUrl) {
                        publicWithPlaylist++;
                    }
                }

                const targets = this.targetManager.getTargets();
                const matchedTargets = targets.filter(target => streamByBroadcaster.has(target.accountId)).length;
                const feedSummary =
                    `returned=${streams.length} totalCount=${streamIdsResponseBody.totalCount ?? "unknown"} ` +
                    `publicWithPlaylist=${publicWithPlaylist} configuredTargets=${targets.length} matchedTargets=${matchedTargets}`;
                if (this.lastFeedSummary !== feedSummary) {
                    logger.info(`[Tango] Feed summary: ${feedSummary}`);
                    this.lastFeedSummary = feedSummary;
                }

                for (const target of targets) {
                    const streamerId = target.accountId;
                    const alias = target.alias;
                    const stream = streamByBroadcaster.get(streamerId);

                    if (!stream) {
                        this.logDecision(streamerId, alias, "not present in /following live feed");
                        continue;
                    }

                    const masterPlaylistUrl = stream.playlistUrl;
                    if (stream.kind !== "PUBLIC") {
                        this.logDecision(streamerId, alias, `present in /following but kind=${stream.kind}`);
                        continue;
                    }

                    if (!masterPlaylistUrl) {
                        this.logDecision(streamerId, alias, "present in /following but missing playlistUrl");
                        continue;
                    }

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
                    this.logDecision(streamerId, alias, "public live stream found in /following; starting");

                    const downloadHandle = this.downloadsManager.add(masterPlaylistUrl, {
                        streamerId: streamerId,
                        alias: alias,
                    });

                    if (downloadHandle) {
                        logger.info(`[Tango] Initiating session for ${alias}...`);
                        const session = new StreamSession(streamerId, alias, downloadHandle, this.apiClient);
                        const completion = session.run(masterPlaylistUrl).then((result: SessionResult) => {
                            if (!result.aborted && result.totalSegments === 0) {
                                this.cooldown.recordFailure(streamerId);
                            } else if (result.totalSegments > 0) {
                                this.cooldown.clear(streamerId);
                            }
                        }).catch((err: Error) => {
                            logger.error(`[Tango] ${alias}: unhandled session error`, { error: err.message });
                            downloadHandle.remove();
                            this.cooldown.recordFailure(streamerId);
                        });
                        this.downloadsManager.registerDownloader(masterPlaylistUrl, () => session.abort(), completion);
                    }
                }
            } else {
                logger.verbose("[Tango] Poll complete: No new streams found or unable to fetch.");
            }
            await timersPromises.setTimeout(TANGO_POLL_MS);
        }
    }
}
