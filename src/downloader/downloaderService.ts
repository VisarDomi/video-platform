// src/downloader/downloaderService.ts
import * as timersPromises from "timers/promises";

import * as config from "../common/config.js";
import logger from "../common/logger.js";

import { ApiClient } from "./apiClient.js";
import { DownloadsManager } from "./downloadsManager.js";
import { AliasManager } from "./aliasManager.js";
import { StreamDownloader } from "./streamDownloader.js";

export class DownloaderService {
    private downloadsManager: DownloadsManager;
    private aliasManager: AliasManager;
    private apiClient: ApiClient;

    private constructor(downloadsManager: DownloadsManager, aliasManager: AliasManager, apiClient: ApiClient) {
        this.downloadsManager = downloadsManager;
        this.aliasManager = aliasManager;
        this.apiClient = apiClient;
        logger.info("DownloaderService initialized.");
    }

    public static async create(): Promise<DownloaderService> {
        const downloadsManager = await DownloadsManager.create();
        const aliasManager = await AliasManager.create();
        const apiClient = await ApiClient.create();
        return new DownloaderService(downloadsManager, aliasManager, apiClient);
    }

    public async start() {
        logger.info("Starting Downloader Service...");

        // Start the background watchers
        this.apiClient.startTokenWatcher();
        this._startStreamWatcher();
        this._startAliasUpdater();
    }

    private _startAliasUpdater() {
        const updateAliases = async () => {
            logger.info("Performing hourly alias cache update...");
            try {
                // Step 1: Get all followed account IDs
                const followingsResponse = await this.apiClient.getAllFollowing();

                if (!followingsResponse || !followingsResponse.followers || followingsResponse.followers.length === 0) {
                    logger.warn("Alias update failed: Did not receive a valid list of followers from the 'allfollow' endpoint.");
                    return;
                }

                const followers = followingsResponse.followers;
                logger.info(`Step 1/2 SUCCESS: Fetched ${followers.length} followed accounts from 'allfollow' endpoint.`);
                const streamerIds = followers.map((f: any) => f.accountId);

                // Step 2: Get aliases for those IDs in a single batch request
                const batchResponse = await this.apiClient.getAliasesInBatch(streamerIds);

                if (!batchResponse) {
                    logger.error("Alias update failed: The POST request to the 'batch' endpoint returned no data.");
                    return;
                }
                logger.info(`Step 2/2 SUCCESS: Received response from 'batch' endpoint.`);

                const aliasMap: { [key: string]: string } = {};
                for (const streamerId in batchResponse) {
                    const alias = batchResponse[streamerId]?.basicProfile?.aliases?.[0]?.alias;
                    if (alias) {
                        aliasMap[streamerId] = alias;
                    }
                }

                if (Object.keys(aliasMap).length > 0) {
                    this.aliasManager.batchSet(aliasMap);
                    logger.info(`Alias cache updated with ${Object.keys(aliasMap).length} entries (out of ${streamerIds.length} IDs sent).`);
                } else {
                    logger.warn("Could not extract any valid aliases from the batch response. Cache not updated.");
                }
            } catch (error) {
                logger.error("An unexpected error occurred during the alias update process.", { error });
            }
        };

        // Fire-and-forget initial update
        updateAliases();

        // Schedule subsequent updates every hour
        setInterval(updateAliases, 60 * 60 * 1000);
    }

    private async _startStreamWatcher() {
        let lastKnownTotal = -1;

        while (true) {
            try {
                const streamIdsResponseBody = await this.apiClient.getFollowingResponseBody();

                const currentTotal = this.downloadsManager.size;
                if (currentTotal !== lastKnownTotal) {
                    logger.info(`Watching for streams... Total active/pending: ${currentTotal}`);
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
                                logger.info(`Discovered new stream from ${streamerId}.`);

                                let alias = this.aliasManager.get(streamerId);
                                if (!alias) {
                                    logger.info(`Alias for ${streamerId} not in cache. Fetching from API...`);
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
                                    logger.info(`Initiating download for ${alias || streamerId}...`);
                                    const streamDownloader = new StreamDownloader(downloadHandle, this.apiClient);
                                    streamDownloader.start(); // Fire-and-forget
                                }
                            }
                        }
                    }
                } else {
                    // This covers cases where response is null (no tokens/error) or valid but empty.
                    // The requests module already logs specifics about token/network errors.
                    logger.verbose("Poll complete: No new streams found or unable to fetch.");
                }
            } catch (error) {
                logger.error("Failed to poll for following streams.", { error });
            }
            await timersPromises.setTimeout(config.getConfig().intervals.pollFollowing);
        }
    }
}
