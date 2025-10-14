// src/downloader/aliasSyncService.ts
import logger from "../common/logger.js";
import { ApiClient } from "./apiClient.js";
import { AliasManager } from "./aliasManager.js";

export class AliasSyncService {
    private apiClient: ApiClient;
    private aliasManager: AliasManager;

    constructor(apiClient: ApiClient, aliasManager: AliasManager) {
        this.apiClient = apiClient;
        this.aliasManager = aliasManager;
        logger.info("AliasSyncService initialized.");
    }

    public start(): void {
        const performSync = async () => {
            logger.info("Performing hourly alias cache update...");

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
        };

        // Fire-and-forget initial update
        performSync();

        // Schedule subsequent updates every hour
        setInterval(performSync, 60 * 60 * 1000);
    }
}
