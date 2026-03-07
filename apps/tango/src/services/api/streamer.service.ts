import { CONSTANTS } from "../../core/constants";
import { Streamer } from "../../types";

export interface ProfileData {
    alias: string | null;
    firstName: string | null;
}

export class StreamerService {
    private defaultInit: RequestInit;
    private blockListCache: string[] | null = null;

    constructor(defaultInit: RequestInit) {
        this.defaultInit = defaultInit;
    }

    private async _fetchBlockList(): Promise<string[]> {
        if (this.blockListCache !== null) {
            return this.blockListCache;
        }
        try {
            const response = await fetch(CONSTANTS.API.BLOCK_LIST, this.defaultInit);
            if (response.ok) {
                const blockList = await response.json();
                this.blockListCache = blockList;
                return blockList;
            }
        } catch (error) {
            console.error("Failed to fetch block list:", error);
        }
        return [];
    }

    public async fetchStreamers(count: number): Promise<Streamer[]> {
        const recommendationsInit = {
            ...this.defaultInit,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                sessionId: "",
                locale: "en_US",
                region: "AL",
                categoryPageSize: count,
                streamPageSize: count,
                page: 0,
                moderationLevel: 5,
                nsfwModerationLevel: 5,
                accessToPremium: false,
            }),
        };

        try {
            const [recommendationsResponse, blockList] = await Promise.all([fetch(CONSTANTS.API.RECOMMENDATIONS, recommendationsInit), this._fetchBlockList()]);

            if (recommendationsResponse.ok) {
                const recommendations = await recommendationsResponse.json();
                const streamers: Streamer[] = [];

                if (recommendations?.categoryInfoList) {
                    for (const category of recommendations.categoryInfoList) {
                        if (category.streamInfoList?.streamDetails) {
                            for (const detail of category.streamInfoList.streamDetails) {
                                if (detail.anchor?.encryptedAccountId && detail.stream?.masterListUrl && detail.stream?.id) {
                                    const streamerId = detail.anchor.encryptedAccountId;
                                    if (!blockList.includes(streamerId)) {
                                        streamers.push({
                                            streamerId,
                                            streamId: detail.stream.id,
                                            masterListUrl: detail.stream.masterListUrl,
                                            firstName: detail.anchor.firstName,
                                            isFollowing: category.tag === "following",
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
                return streamers;
            }
        } catch (error) {
            console.error("Failed to fetch streamers:", error);
        }
        return [];
    }

    public async fetchMultiBroadcastStreamers(streamId: string): Promise<Streamer[]> {
        try {
            const [multiBroadcastResponse, blockList] = await Promise.all([
                fetch(CONSTANTS.API.STREAM_WATCH, {
                    ...this.defaultInit,
                    method: "POST",
                    body: streamId,
                }),
                this._fetchBlockList(),
            ]);

            if (multiBroadcastResponse.ok) {
                const data = await multiBroadcastResponse.json();
                const multiBroadcastStreams = data?.multiBroadcast?.streams;

                if (!Array.isArray(multiBroadcastStreams)) {
                    return [];
                }

                return multiBroadcastStreams
                    .map((item: any): Streamer | null => {
                        const descriptor = item.stream?.mbDescriptor;
                        if (descriptor?.accountId && descriptor?.streamId && item.stream?.streamURL) {
                            return {
                                streamerId: descriptor.accountId,
                                streamId: descriptor.streamId,
                                masterListUrl: item.stream.streamURL,
                                firstName: "...", // Will be updated by AliasService
                                isFollowing: false,
                            };
                        }
                        return null;
                    })
                    .filter((s): s is Streamer => s !== null)
                    .filter((s) => !blockList.includes(s.streamerId));
            }
        } catch (error) {
            console.error("Failed to fetch multi-broadcast streamers:", error);
        }
        return [];
    }

    public async fetchAliasesInBatch(streamerIds: string[]): Promise<Record<string, ProfileData> | null> {
        if (streamerIds.length === 0) {
            return {};
        }
        try {
            const response = await fetch(`${CONSTANTS.API.BATCH_ALIAS}?basicProfile=true&liveStats=false&followStats=false`, {
                ...this.defaultInit,
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(streamerIds),
            });
            if (!response.ok) {
                console.error(`Failed to fetch aliases in batch, status: ${response.status}`);
                return null;
            }

            const body = await response.json();
            const resultMap: Record<string, ProfileData> = {};

            for (const streamerId in body) {
                const profile = body[streamerId]?.basicProfile;
                if (profile) {
                    resultMap[streamerId] = {
                        alias: profile.aliases?.[0]?.alias || null,
                        firstName: profile.firstName || null
                    };
                }
            }

            return resultMap;
        } catch (error) {
            console.error("Failed to fetch aliases in batch:", error);
        }
        return null;
    }

    public async fetchAlias(streamerId: string): Promise<ProfileData | null> {
        try {
            const response = await fetch(`${CONSTANTS.API.ALIAS}?id=${streamerId}&basicProfile=true&liveStats=false&followStats=false`, this.defaultInit);
            if (!response.ok) return null;
            const body = await response.json();

            const profile = body?.basicProfile;
            if (!profile) return null;

            return {
                alias: profile.aliases?.[0]?.alias || null,
                firstName: profile.firstName || null
            };

        } catch (error) {
            console.error("Failed to fetch alias:", error);
        }
        return null;
    }
}