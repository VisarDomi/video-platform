// src/downloader/downloaderService.ts
import * as fsPromises from "fs/promises";
import * as timersPromises from "timers/promises";
import * as path from "path";

import * as config from "../common/config.js";
import logger from "../common/logger.js";

import * as requests from "./requests.js";
import { DownloadsManager } from "./downloadsManager.js";
import { AliasManager } from "./aliasManager.js";
import { StreamDownloader } from "./streamDownloader.js";

export class DownloaderService {
    private downloadsManager: DownloadsManager;
    private aliasManager: AliasManager;
    private tokens: requests.Tokens | null = null;

    /**
     * The constructor is now private. Use the async `create` method instead.
     */
    private constructor(downloadsManager: DownloadsManager, aliasManager: AliasManager) {
        this.downloadsManager = downloadsManager;
        this.aliasManager = aliasManager;
        logger.info("DownloaderService initialized.");
    }

    /**
     * Asynchronously creates and initializes a DownloaderService.
     */
    public static async create(): Promise<DownloaderService> {
        const downloadsManager = await DownloadsManager.create();
        const aliasManager = await AliasManager.create();
        return new DownloaderService(downloadsManager, aliasManager);
    }

    public async start() {
        logger.info("Starting Downloader Service...");
        await this._loadInitialTokens(); // Wait for the first token load

        // Now start the background watchers
        this._startTokenWatcher();
        this._startStreamWatcher();
        this._startAliasUpdater();
    }

    private async _loadInitialTokens(): Promise<boolean> {
        try {
            const cfg = config.getConfig();
            const sessionFilePath = path.resolve(cfg.sharedStatePath, "session.json");
            const data = await fsPromises.readFile(sessionFilePath, "utf-8");
            const session = JSON.parse(data);

            if (session.tangoST && session.tt && session.ttu && session.tte) {
                this.tokens = {
                    st: session.tangoST,
                    tt: session.tt,
                    ttu: session.ttu,
                    tte: session.tte,
                };
                return true;
            } else {
                logger.warn("Initial token load failed: session.json is missing required tokens.");
                this.tokens = null;
                return false;
            }
        } catch (error: any) {
            if (error.code === "ENOENT") {
                logger.warn("Initial token load failed: session.json not found.");
            } else {
                logger.error("Failed to read tokens from session file", { error });
            }
            this.tokens = null;
            return false;
        }
    }

    private async _startTokenWatcher() {
        const refreshInterval = config.getConfig().intervals.shortTokenRefresh;
        // Wait for the initial interval before the first refresh to avoid immediate re-reading
        await timersPromises.setTimeout(refreshInterval);

        while (true) {
            await this._loadInitialTokens(); // Reuse the same logic for refreshing
            await timersPromises.setTimeout(refreshInterval);
        }
    }

    private _startAliasUpdater() {
        const updateAliases = async () => {
            while (!this.tokens) {
                logger.info("Alias updater waiting for tokens...");
                await timersPromises.setTimeout(config.getConfig().intervals.shortTokenRefresh);
            }

            logger.info("Performing hourly alias cache update...");
            try {
                // Step 1: Get all followed account IDs
                const followingsResponse = await requests.getAllFollowing(this.tokens);

                if (!followingsResponse || !followingsResponse.followers || followingsResponse.followers.length === 0) {
                    logger.warn("Alias update failed: Did not receive a valid list of followers from the 'allfollow' endpoint.");
                    return;
                }

                const followers = followingsResponse.followers;
                logger.info(`Step 1/2 SUCCESS: Fetched ${followers.length} followed accounts from 'allfollow' endpoint.`);
                const streamerIds = followers.map((f: any) => f.accountId);

                // Step 2: Get aliases for those IDs in a single batch request
                const batchResponse = await requests.getAliasesInBatch(streamerIds, this.tokens);

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
                if (!this.tokens) {
                    logger.warn("Tokens not available. Downloader is waiting for auth service to provide them...");
                    await timersPromises.setTimeout(config.getConfig().intervals.shortTokenRefresh);
                    continue;
                }

                const streamIdsResponseBody = await requests.getFollowingResponseBody(this.tokens);

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
                                if (!alias && this.tokens) {
                                    logger.info(`Alias for ${streamerId} not in cache. Fetching from API...`);
                                    alias = await requests.getStreamerAlias(streamerId, this.tokens);
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
                                    const streamDownloader = new StreamDownloader(downloadHandle, () => this.tokens);
                                    streamDownloader.start(); // Fire-and-forget
                                }
                            }
                        }
                    }
                } else {
                    logger.verbose("Poll complete: No stream entities found in the response.");
                }
            } catch (error) {
                logger.error("Failed to poll for following streams.", { error });
            }
            await timersPromises.setTimeout(config.getConfig().intervals.pollFollowing);
        }
    }
}
