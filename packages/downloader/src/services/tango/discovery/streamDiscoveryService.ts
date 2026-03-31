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

    constructor(apiClient: ApiClient, targetManager: TangoTargetManager, downloadsManager: DownloadsManager) {
        this.apiClient = apiClient;
        this.targetManager = targetManager;
        this.downloadsManager = downloadsManager;
        logger.debug("[Tango] StreamDiscoveryService initialized.");
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
                const streamIds: string[] = Object.keys(streamIdsResponseBody.entities.stream);
                for (const streamId of streamIds) {
                    const stream = streamIdsResponseBody.entities.stream[streamId];
                    const masterPlaylistUrl = stream.playlistUrl;
                    const streamerId = stream.broadcasterId;

                    if (stream.kind === "PUBLIC" && streamerId && masterPlaylistUrl) {
                        if (!this.downloadsManager.has(masterPlaylistUrl) && !this.downloadsManager.hasStreamer(streamerId)) {
                            if (this.cooldown.isActive(streamerId)) continue;

                            if (this.targetManager.size === 0 || !this.targetManager.hasTarget(streamerId)) {
                                logger.verbose(`[Tango] Skipping ${streamerId} (not in tango.txt)`);
                                continue;
                            }

                            const alias = this.targetManager.getAlias(streamerId) || streamerId;

                            logger.info(`[Tango] Discovered new stream from ${alias}.`);

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
                    }
                }
            } else {
                logger.verbose("[Tango] Poll complete: No new streams found or unable to fetch.");
            }
            await timersPromises.setTimeout(TANGO_POLL_MS);
        }
    }
}
