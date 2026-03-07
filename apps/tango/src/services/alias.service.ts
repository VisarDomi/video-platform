import { ICacheManager } from "../types";
import { StreamerService } from "./api/streamer.service";

export class AliasService {
    private streamerService: StreamerService;
    private cache: ICacheManager;

    constructor(streamerService: StreamerService, cacheManager: ICacheManager) {
        this.streamerService = streamerService;
        this.cache = cacheManager;
    }

    public getCachedAlias(streamerId: string): string | undefined {
        return this.cache.getAlias(streamerId);
    }

    public getCachedName(streamerId: string): string | undefined {
        return this.cache.getName(streamerId);
    }

    public async getAliasFor(streamerId: string): Promise<string> {
        const cachedAlias = this.cache.getAlias(streamerId);

        if (cachedAlias) {
            return cachedAlias;
        }

        const profileData = await this.streamerService.fetchAlias(streamerId);

        if (profileData) {
            if (profileData.alias) {
                this.cache.setAlias(streamerId, profileData.alias);
            }
            if (profileData.firstName) {
                this.cache.setName(streamerId, profileData.firstName);
            }
            return profileData.alias || streamerId;
        }

        return streamerId;
    }

    /**
     * Batched fetch for aliases.
     * @param streamerIds List of streamer IDs to check.
     * @param forceUpdate If true, fetches from API even if cached data exists (used for refreshing stale data).
     */
    public async getAliasesFor(streamerIds: string[], forceUpdate: boolean = false): Promise<void> {
        const idsToFetch: string[] = [];

        for (const streamerId of streamerIds) {
            const cachedAlias = this.cache.getAlias(streamerId);

            // Decide whether to fetch
            if (forceUpdate || !cachedAlias) {
                idsToFetch.push(streamerId);
            }
        }

        if (idsToFetch.length > 0) {
            const results = await this.streamerService.fetchAliasesInBatch(idsToFetch);
            if (results) {
                for (const streamerId in results) {
                    const data = results[streamerId];
                    if (data.alias) {
                        this.cache.setAlias(streamerId, data.alias);
                    }
                    if (data.firstName) {
                        this.cache.setName(streamerId, data.firstName);
                    }
                }
            }
        }
    }
}
