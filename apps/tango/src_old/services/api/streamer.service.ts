import {CONSTANTS} from "../../core/constants";
import {xhrFetch} from "../../core/xhr-fetch";
import {Streamer} from "../../types";

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

export class StreamerService {
    private followingIdsCache: Set<string> | null = null;
    private followingIdsCacheTime: number = 0;

    private async _fetchBlockList(): Promise<string[]> {
        const response = await xhrFetch(CONSTANTS.API.BLOCK_LIST);
        const body = await response.json();
        return Array.isArray(body) ? body : (body?.users || []);
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
        if (this.followingIdsCache !== null && (Date.now() - this.followingIdsCacheTime) < 60_000) {
            return [...this.followingIdsCache];
        }
        const followingIds = new Set<string>();
        let cursor: string | null = null;

        do {
            const params = new URLSearchParams({size: String(CONSTANTS.APP.FOLLOWINGS_PAGE_SIZE)});
            if (cursor) {
                params.set("cursor", cursor);
            }
                const response = await xhrFetch(`${CONSTANTS.API.MY_FOLLOWINGS}?${params.toString()}`);

            if (!response.ok) {
                this.followingIdsCache = followingIds;
                return [...followingIds];
            }

            const body = await response.json();
            const rawFollowings = body?.followers || body?.followings || body?.records || body?.items || [];

            if (!Array.isArray(rawFollowings)) {
                this.followingIdsCache = followingIds;
                return [...followingIds];
            }

            rawFollowings
                .map((entry: FollowingEntry) => this.extractFollowingId(entry))
                .filter((id: string | null): id is string => Boolean(id))
                .forEach((id: string) => followingIds.add(id));

            cursor = body?.nextCursor || null;
        } while (cursor);

        this.followingIdsCache = followingIds;
        this.followingIdsCacheTime = Date.now();
        return [...this.followingIdsCache];
    }

    private recommendatorRecordToStreamer(record: any, blockList: string[], isFollowing: boolean): Streamer | null {
        const streamerId = record.anchor?.encryptedAccountId || record.stream?.encryptedAccountId;
        const streamId = record.stream?.id;
        const masterListUrl = record.stream?.masterListUrl;
        const isLive = record.stream?.status === "LIVING";
        const isPublic = record.isPublic === true || record.stream?.streamKind === "PUBLIC";

        if (!streamerId || !streamId || !masterListUrl || !isLive || !isPublic || blockList.includes(streamerId)) {
            return null;
        }

        return {
            streamerId,
            streamId,
            masterListUrl,
            firstName: record.anchor?.firstName,
            isFollowing,
        };
    }


    private async _fetchRecommendator(url: string, blockList: string[], isFollowing: boolean): Promise<Streamer[]> {
        const response = await xhrFetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        });
        const body = await response.json();
        const records = body?.records;
        return records
            .map((r: any) => this.recommendatorRecordToStreamer(r, blockList, isFollowing))
            .filter((s: Streamer | null): s is Streamer => s !== null);
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

    public async fetchStreamers(): Promise<Streamer[]> {
        const blockList = await this._fetchBlockList();
        const [followed, recommended] = await Promise.all([
            this._fetchRecommendator(CONSTANTS.API.RECOMMENDATOR_FOLLOWING, blockList, true),
            this._fetchRecommendator(CONSTANTS.API.RECOMMENDATOR_RECOMMENDATIONS, blockList, false),
        ]);

        const followedIds = new Set(followed.map(s => s.streamerId));
        for (const s of recommended) {
            if (followedIds.has(s.streamerId)) s.isFollowing = true;
        }

        return this.dedupeStreamers([...followed, ...recommended]);
    }

    public async fetchMultiBroadcastStreamers(streamId: string): Promise<Streamer[]> {
        const [multiBroadcastResponse, blockList, followingIds] = await Promise.all([
            xhrFetch(CONSTANTS.API.STREAM_WATCH, {
                method: "POST",
                body: streamId,
            }),
            this._fetchBlockList(),
            this.fetchFollowingIds(),
        ]);
        const followingIdSet = new Set(followingIds);
        const data = await multiBroadcastResponse.json();
        const multiBroadcastStreams = data?.multiBroadcast?.streams;
        return multiBroadcastStreams
            .map((item: any): Streamer | null => {
                const descriptor = item.stream?.mbDescriptor;
                return {
                    streamerId: descriptor.accountId,
                    streamId: descriptor.streamId,
                    masterListUrl: item.stream.streamURL,
                    firstName: "...",
                    isFollowing: followingIdSet.has(descriptor.accountId),
                };
            })
            .filter((s: any): s is Streamer => s !== null)
            .filter((s: any) => !blockList.includes(s.streamerId));
    }

    public async fetchAliasesInBatch(streamerIds: string[]): Promise<Record<string, ProfileData> | null> {
        if (streamerIds.length === 0) return {};
        const response = await xhrFetch(`${CONSTANTS.API.BATCH_ALIAS}?basicProfile=true&liveStats=false&followStats=false`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(streamerIds),
        });

        const body = await response.json();
        const resultMap: Record<string, ProfileData> = {};

        for (const streamerId in body) {
            const profile = body[streamerId]?.basicProfile;
            if (profile) {
                resultMap[streamerId] = {
                    alias: profile.aliases?.[0]?.alias,
                    firstName: profile.firstName
                };
            }
        }

        return resultMap;
    }

    public async fetchAlias(streamerId: string): Promise<ProfileData | null> {
        const response = await xhrFetch(`${CONSTANTS.API.ALIAS}?id=${streamerId}&basicProfile=true&liveStats=false&followStats=false`);
        const body = await response.json();
        const profile = body?.basicProfile;

        return {
            alias: profile.aliases?.[0]?.alias,
            firstName: profile.firstName
        };
    }
}
