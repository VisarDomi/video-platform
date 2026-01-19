import * as timersPromises from "timers/promises";

import * as config from "../../../common/config.js";
import logger from "../../../common/logger.js";
import { StreamDownloader } from "../../download/streamDownloader.js";
import { AliasManager } from "../../state/aliasManager.js";
import { DownloadsManager } from "../../state/downloadsManager.js";
import { ApiClient } from "../api/apiClient.js";

export class StreamDiscoveryService {
    private readonly apiClient: ApiClient;
    private aliasManager: AliasManager;
    private downloadsManager: DownloadsManager;

    constructor(apiClient: ApiClient, aliasManager: AliasManager, downloadsManager: DownloadsManager) {
        this.apiClient = apiClient;
        this.aliasManager = aliasManager;
        this.downloadsManager = downloadsManager;
        logger.info("[Tango] StreamDiscoveryService initialized.");
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
                        if (!this.downloadsManager.has(masterPlaylistUrl)) {
                            logger.info(`[Tango] Discovered new stream from ${streamerId}.`);

                            let alias = this.aliasManager.get(streamerId);
                            if (!alias) {
                                logger.info(`[Tango] Alias for ${streamerId} not in cache. Fetching from API...`);
                                alias = await this.apiClient.getStreamerAlias(streamerId);
                                if (alias && alias !== streamerId) {
                                    this.aliasManager.set(streamerId, alias);
                                }
                            }

                            const downloadHandle = this.downloadsManager.add(masterPlaylistUrl, {
                                streamerId: streamerId,
                                alias: alias || streamerId,
                            });

                            if (downloadHandle) {
                                logger.info(`[Tango] Initiating download for ${alias || streamerId}...`);
                                const streamDownloader = new StreamDownloader(downloadHandle, this.apiClient);
                                void streamDownloader.start();
                            }
                        }
                    }
                }
            } else {
                logger.verbose("[Tango] Poll complete: No new streams found or unable to fetch.");
            }
            await timersPromises.setTimeout(config.getConfig().intervals.pollFollowing);
        }
    }
}