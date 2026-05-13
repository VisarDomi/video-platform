import { CONSTANTS } from "../../core/constants";
import { Streamer } from "../../types";

export interface ProfileData {
    alias: string | null;
    firstName: string | null;
}

interface FollowingEntry {
    encryptedAccountId?: string;
    accountId?: string;
    id?: string;
    account?: {
        encryptedAccountId?: string;
        accountId?: string;
        id?: string;
    };
    profile?: {
        encryptedAccountId?: string;
        accountId?: string;
        id?: string;
    };
}

interface LiveRecord {
    isPublic?: boolean;
    account?: {
        encryptedAccountId?: string;
        firstName?: string;
    };
    anchor?: {
        encryptedAccountId?: string;
        firstName?: string;
    };
    stream?: {
        id?: string;
        streamId?: string;
        encryptedAccountId?: string;
        accountId?: string;
        broadcasterId?: string;
        masterListUrl?: string;
        streamKind?: string;
        status?: string;
    };
    viewInfo?: {
        streamId?: string;
        hlsStreamInfo?: {
            masterUrl?: string;
        };
    };
}

interface RecommendationCategory {
    tag?: string;
    streamInfoList?: {
        streamDetails?: RecommendationDetail[];
    };
}

interface RecommendationDetail {
    anchor?: {
        encryptedAccountId?: string;
        firstName?: string;
    };
    stream?: {
        id?: string;
        masterListUrl?: string;
    };
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

    private extractFollowingId(entry: FollowingEntry): string | null {
        return entry.encryptedAccountId
            || entry.accountId
            || entry.id
            || entry.account?.encryptedAccountId
            || entry.account?.accountId
            || entry.account?.id
            || entry.profile?.encryptedAccountId
            || entry.profile?.accountId
            || entry.profile?.id
            || null;
    }

    private async fetchFollowingIds(): Promise<string[]> {
        try {
            const followingIds = new Set<string>();
            let cursor: string | null = null;

            do {
                const params = new URLSearchParams({ size: String(CONSTANTS.APP.FOLLOWINGS_PAGE_SIZE) });
                if (cursor) {
                    params.set("cursor", cursor);
                }
                const response = await fetch(`${CONSTANTS.API.MY_FOLLOWINGS}?${params.toString()}`, this.defaultInit);

                if (!response.ok) {
                    console.error(`Failed to fetch following ids, status: ${response.status}`);
                    return [...followingIds];
                }

                const body = await response.json();
                const rawFollowings = body?.followers || body?.followings || body?.records || body?.items || [];

                if (!Array.isArray(rawFollowings)) {
                    return [...followingIds];
                }

                rawFollowings
                    .map((entry: FollowingEntry) => this.extractFollowingId(entry))
                    .filter((id: string | null): id is string => Boolean(id))
                    .forEach((id: string) => followingIds.add(id));

                cursor = body?.nextCursor || null;
            } while (cursor);

            return [...followingIds];
        } catch (error) {
            console.error("Failed to fetch following ids:", error);
            return [];
        }
    }

    private async delay(ms: number): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }

    private liveRecordToStreamer(record: LiveRecord, blockList: string[]): Streamer | null {
        const stream = record.stream;
        const streamerId = stream?.encryptedAccountId || stream?.accountId || stream?.broadcasterId || record.account?.encryptedAccountId || record.anchor?.encryptedAccountId;
        const streamId = stream?.id || stream?.streamId || record.viewInfo?.streamId;
        const masterListUrl = stream?.masterListUrl || record.viewInfo?.hlsStreamInfo?.masterUrl;
        const isLive = typeof stream?.status !== "string" || stream.status === "LIVING";
        const isPublic = stream?.streamKind === "PUBLIC" || record.isPublic === true;

        if (!streamerId || !streamId || !masterListUrl || !isLive || !isPublic || blockList.includes(streamerId)) {
            return null;
        }

        return {
            streamerId,
            streamId,
            masterListUrl,
            firstName: record.account?.firstName || record.anchor?.firstName || "...",
            isFollowing: true,
        };
    }

    private async fetchLiveFollowings(accountIds: string[], blockList: string[]): Promise<Streamer[]> {
        const streamers: Streamer[] = [];
        const batchSize = CONSTANTS.APP.LIVE_CHECK_BATCH_SIZE;

        for (let index = 0; index < accountIds.length; index += batchSize) {
            const batch = accountIds.slice(index, index + batchSize);
            const response = await fetch(`${CONSTANTS.API.LIVE_BY_ACCOUNT_IDS}?pageSize=${batch.length}`, {
                ...this.defaultInit,
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    moderationLevel: 5,
                    accountIds: batch,
                    forceAllowPulsz: false,
                }),
            });

            if (!response.ok) {
                console.error(`Failed to fetch live followings batch, status: ${response.status}`);
            } else {
                const body = await response.json();
                const records = body?.records || body?.items || [];

                if (Array.isArray(records)) {
                    for (const record of records) {
                        const streamer = this.liveRecordToStreamer(record, blockList);
                        if (streamer) {
                            streamers.push(streamer);
                        }
                    }
                }
            }

            if (index + batchSize < accountIds.length) {
                await this.delay(CONSTANTS.APP.LIVE_CHECK_BATCH_DELAY_MS);
            }
        }

        return streamers;
    }

    private recommendationToStreamer(detail: RecommendationDetail, blockList: string[], isFollowing: boolean): Streamer | null {
        const streamerId = detail.anchor?.encryptedAccountId;
        const streamId = detail.stream?.id;
        const masterListUrl = detail.stream?.masterListUrl;

        if (!streamerId || !streamId || !masterListUrl || blockList.includes(streamerId)) {
            return null;
        }

        return {
            streamerId,
            streamId,
            masterListUrl,
            firstName: detail.anchor?.firstName || "...",
            isFollowing,
        };
    }

    private async fetchRecommendedStreamers(count: number, blockList: string[]): Promise<Streamer[]> {
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
            const response = await fetch(CONSTANTS.API.RECOMMENDATIONS, recommendationsInit);
            if (!response.ok) {
                console.error(`Failed to fetch recommended streamers, status: ${response.status}`);
                return [];
            }

            const recommendations = await response.json();
            const categories = recommendations?.categoryInfoList || [];
            const streamers: Streamer[] = [];

            if (!Array.isArray(categories)) {
                return [];
            }

            for (const category of categories as RecommendationCategory[]) {
                const details = category.streamInfoList?.streamDetails || [];
                for (const detail of details) {
                    const streamer = this.recommendationToStreamer(detail, blockList, category.tag === "following");
                    if (streamer) {
                        streamers.push(streamer);
                    }
                }
            }

            return streamers;
        } catch (error) {
            console.error("Failed to fetch recommended streamers:", error);
            return [];
        }
    }

    private dedupeStreamers(streamers: Streamer[]): Streamer[] {
        const byStreamerId = new Map<string, Streamer>();

        for (const streamer of streamers) {
            const existing = byStreamerId.get(streamer.streamerId);
            if (!existing || (!existing.isFollowing && streamer.isFollowing)) {
                byStreamerId.set(streamer.streamerId, streamer);
            }
        }

        return [...byStreamerId.values()];
    }

    public async fetchStreamers(count: number): Promise<Streamer[]> {
        try {
            const [followingIds, blockList] = await Promise.all([this.fetchFollowingIds(), this._fetchBlockList()]);
            const followedLiveStreamers = followingIds.length > 0 ? await this.fetchLiveFollowings(followingIds, blockList) : [];
            const recommendedStreamers = await this.fetchRecommendedStreamers(count, blockList);

            return this.dedupeStreamers([...followedLiveStreamers, ...recommendedStreamers]);
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
