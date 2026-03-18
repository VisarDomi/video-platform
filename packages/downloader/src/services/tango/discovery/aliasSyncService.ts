import logger from "../../../common/logger.js";
import { AliasManager } from "shared";
import { ApiClient } from "../api/apiClient.js";

export class AliasSyncService {
    private apiClient: ApiClient;
    private aliasManager: AliasManager;

    constructor(apiClient: ApiClient, aliasManager: AliasManager) {
        this.apiClient = apiClient;
        this.aliasManager = aliasManager;
        logger.info("[Tango] AliasSyncService initialized.");
    }

    public start(): void {
        const performSync = async () => {
            logger.info("[Tango] Performing hourly alias cache update...");

            const followingsResponse = await this.apiClient.getAllFollowing();
            if (!followingsResponse || !followingsResponse.followers || followingsResponse.followers.length === 0) {
                logger.warn("[Tango] Alias update failed: Did not receive a valid list of followers from the 'allfollow' endpoint.");
                return;
            }
            const followers = followingsResponse.followers;
            logger.info(`[Tango] Step 1/2 SUCCESS: Fetched ${followers.length} followed accounts from 'allfollow' endpoint.`);
            const streamerIds = followers.map((f: any) => f.accountId);

            const batchResponse = await this.apiClient.getAliasesInBatch(streamerIds);
            if (!batchResponse) {
                logger.error("[Tango] Alias update failed: The POST request to the 'batch' endpoint returned no data.");
                return;
            }
            logger.info(`[Tango] Step 2/2 SUCCESS: Received response from 'batch' endpoint.`);

            const aliasMap: { [key: string]: string } = {};
            for (const streamerId in batchResponse) {
                const alias = batchResponse[streamerId]?.basicProfile?.aliases?.[0]?.alias;
                if (alias) {
                    aliasMap[streamerId] = alias;
                }
            }

            if (Object.keys(aliasMap).length > 0) {
                await this.aliasManager.batchSet(aliasMap);
                logger.info(`[Tango] Alias cache updated with ${Object.keys(aliasMap).length} entries (out of ${streamerIds.length} IDs sent).`);
            } else {
                logger.warn("[Tango] Could not extract any valid aliases from the batch response. Cache not updated.");
            }
        };

        void performSync();

        setInterval(performSync, 60 * 60 * 1000);
    }
}