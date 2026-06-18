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


export class StreamerService {
    private defaultInit: RequestInit;
    private blockListCache: string[] | null = null;
    private followingIdsCache: Set<string> | null = null;

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
                const body = await response.json();
                const blockList = Array.isArray(body) ? body : (body?.users || []);
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
        if (this.followingIdsCache !== null) {
            return [...this.followingIdsCache];
        }

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
            return [...followingIds];
        } catch (error) {
            console.error("Failed to fetch following ids:", error);
            return [];
        }
    }

    private recommendatorRecordToStreamer(record: any, blockList: string[]): Streamer | null {
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
            firstName: record.anchor?.firstName || "...",
            isFollowing: true,
        };
    }

    private _xhrFetchJSON(url: string, init?: RequestInit): Promise<{ status: number; ok: boolean; json(): Promise<any> }> {
        const { promise, resolve, reject } = Promise.withResolvers<{ status: number; ok: boolean; json(): Promise<any> }>();
        const xhr = new XMLHttpRequest();
        xhr.open(init?.method ?? "GET", url);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json; charset=UTF-8");
        if (init?.headers) {
            const h = init.headers as Record<string, string>;
            Object.keys(h).forEach(k => xhr.setRequestHeader(k, h[k]));
        }
        xhr.onload = () => resolve({ status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300, json: () => Promise.resolve(JSON.parse(xhr.responseText)) });
        xhr.onerror = () => reject(new Error("XHR network error"));
        xhr.send(init?.body as XMLHttpRequestBodyInit | null ?? null);
        return promise;
    }

    private async _fetchRecommendator(url: string, blockList: string[]): Promise<Streamer[]> {
        try {
            const response = await this._xhrFetchJSON(url, {
                ...this.defaultInit as any,
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
            });
            if (!response.ok) {
                console.error(`[tango] Recommendator fetch failed, status: ${response.status}, url: ${url.split("/").slice(-2).join("/")}`);
                return [];
            }
            const body = await response.json();
            const records = body?.records || [];
            if (!Array.isArray(records)) return [];
            return records
                .map((r: any) => this.recommendatorRecordToStreamer(r, blockList))
                .filter((s: Streamer | null): s is Streamer => s !== null);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(`[tango] Recommendator fetch error: ${msg}`);
        }
        return [];
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
        try {
            const blockList = await this._fetchBlockList();
            const [followed, recommended] = await Promise.all([
                this._fetchRecommendator(CONSTANTS.API.RECOMMENDATOR_FOLLOWING, blockList),
                this._fetchRecommendator(CONSTANTS.API.RECOMMENDATOR_RECOMMENDATIONS, blockList),
            ]);
            return this.dedupeStreamers([...followed, ...recommended]);
        } catch (error) {
            console.error("[tango] Failed to fetch streamers:", error);
        }
        return [];
    }

    public async fetchMultiBroadcastStreamers(streamId: string): Promise<Streamer[]> {
        try {
            const [multiBroadcastResponse, blockList, followingIds] = await Promise.all([
                fetch(CONSTANTS.API.STREAM_WATCH, {
                    ...this.defaultInit,
                    method: "POST",
                    body: streamId,
                }),
                this._fetchBlockList(),
                this.fetchFollowingIds(),
            ]);
            const followingIdSet = new Set(followingIds);

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
                                isFollowing: followingIdSet.has(descriptor.accountId),
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
