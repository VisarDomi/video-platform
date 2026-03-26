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
            const followingsResponse = await this.apiClient.getAllFollowing();
            if (!followingsResponse || !followingsResponse.followers || followingsResponse.followers.length === 0) {
                logger.warn("[Tango] Alias sync failed: no followers from allfollow endpoint");
                return;
            }
            const followers = followingsResponse.followers;
            const streamerIds = followers.map((f: any) => f.accountId);

            const batchResponse = await this.apiClient.getAliasesInBatch(streamerIds);
            if (!batchResponse) {
                logger.error("[Tango] Alias sync failed: batch endpoint returned no data");
                return;
            }

            const aliasMap: { [key: string]: string } = {};
            for (const streamerId in batchResponse) {
                const alias = batchResponse[streamerId]?.basicProfile?.aliases?.[0]?.alias;
                if (alias) {
                    aliasMap[streamerId] = alias;
                }
            }

            if (Object.keys(aliasMap).length > 0) {
                await this.aliasManager.batchSet(aliasMap);
                logger.info(`[Tango] Alias cache synced: ${Object.keys(aliasMap).length}/${streamerIds.length} resolved`);
            } else {
                logger.warn("[Tango] Alias sync: no valid aliases in batch response");
            }
        };

        void performSync();

        setInterval(performSync, 60 * 60 * 1000);
    }
}