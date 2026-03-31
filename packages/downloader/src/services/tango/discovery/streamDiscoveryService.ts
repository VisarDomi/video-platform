import * as timersPromises from "timers/promises";

import logger from "../../../common/logger.js";
import { TANGO_POLL_MS } from "../../../common/timing.js";
import { StreamSession, SessionResult } from "../../download/streamSession.js";
import { AliasRegistry } from "shared";
import { DownloadsManager } from "../../state/downloadsManager.js";
import { ApiClient } from "../api/apiClient.js";
import type { TargetManager } from "../../common/targetManager.js";
import { RetryCooldown } from "../../common/retryCooldown.js";

export class StreamDiscoveryService {
    private readonly apiClient: ApiClient;
    private readonly registry: AliasRegistry;
    private downloadsManager: DownloadsManager;
    private targetManager: TargetManager | null = null;
    private cooldown = new RetryCooldown("Tango");

    constructor(apiClient: ApiClient, registry: AliasRegistry, downloadsManager: DownloadsManager) {
        this.apiClient = apiClient;
        this.registry = registry;
        this.downloadsManager = downloadsManager;
        logger.debug("[Tango] StreamDiscoveryService initialized.");
    }

    public setTargetManager(targetManager: TargetManager): void {
        this.targetManager = targetManager;
    }

    private shouldDownload(streamerId: string): boolean {
        if (!this.targetManager || this.targetManager.size === 0) {
            return true;
        }
        return this.targetManager.hasTarget(streamerId);
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

                            if (!this.shouldDownload(streamerId)) {
                                logger.verbose(`[Tango] Skipping ${streamerId} (not in tango.txt)`);
                                continue;
                            }

                            const resolvedAlias = await this.registry.resolveOrFetch(
                                streamerId,
                                (id) => this.apiClient.getStreamerAlias(id),
                            );

                            logger.info(`[Tango] Discovered new stream from ${resolvedAlias}.`);

                            const downloadHandle = this.downloadsManager.add(masterPlaylistUrl, {
                                streamerId: streamerId,
                                alias: resolvedAlias,
                            });

                            if (downloadHandle) {
                                logger.info(`[Tango] Initiating session for ${resolvedAlias}...`);
                                const session = new StreamSession(streamerId, resolvedAlias, downloadHandle, this.apiClient);
                                const completion = session.run(masterPlaylistUrl).then((result: SessionResult) => {
                                    if (!result.aborted && result.totalSegments === 0) {
                                        this.cooldown.recordFailure(streamerId);
                                    } else if (result.totalSegments > 0) {
                                        this.cooldown.clear(streamerId);
                                    }
                                }).catch((err: Error) => {
                                    logger.error(`[Tango] ${resolvedAlias}: unhandled session error`, { error: err.message });
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