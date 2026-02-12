import logger from "../../core/logger.js";
import { getTokens } from "./tokenManager.js";

const API_BASE = "https://gateway.tango.me/proxycador/api/public/v1";

export interface TlStreamer {
    streamerId: string;
    streamId: string;
    alias: string;
    firstName: string;
    masterListUrl: string;
    isFollowing: boolean;
}

interface ProfileData {
    alias: string | null;
    firstName: string | null;
}

function getApiHeaders(): Record<string, string> {
    const tokens = getTokens();
    if (!tokens?.st) {
        throw new Error("Tango-ST token not available");
    }
    return {
        cookie: `Tango-ST=${tokens.st}`,
        Accept: "application/json",
    };
}

let blockListCache: string[] | null = null;

async function fetchBlockList(): Promise<string[]> {
    if (blockListCache !== null) return blockListCache;
    try {
        const headers = getApiHeaders();
        const response = await fetch(`${API_BASE}/blockList`, { headers });
        if (response.ok) {
            blockListCache = (await response.json()) as string[];
            return blockListCache;
        }
    } catch (error) {
        logger.error("[TL] Failed to fetch block list", { error: (error as Error).message });
    }
    return [];
}

export async function fetchStreamers(count: number = 50): Promise<{ following: TlStreamer[]; recommended: TlStreamer[] }> {
    const reqBody = {
        sessionId: "",
        locale: "en_US",
        region: "AL",
        categoryPageSize: count,
        streamPageSize: count,
        page: 0,
        moderationLevel: 5,
        nsfwModerationLevel: 5,
        accessToPremium: false,
    };

    try {
        const headers = getApiHeaders();
        headers["Content-Type"] = "application/json";

        const [recommendationsResponse, blockList] = await Promise.all([
            fetch(`${API_BASE}/recommendations/following?tags=`, {
                method: "POST",
                headers,
                body: JSON.stringify(reqBody),
            }),
            fetchBlockList(),
        ]);

        if (!recommendationsResponse.ok) {
            logger.error(`[TL] Recommendations request failed: ${recommendationsResponse.status}`);
            return { following: [], recommended: [] };
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const recommendations = (await recommendationsResponse.json()) as any;
        const following: TlStreamer[] = [];
        const recommended: TlStreamer[] = [];

        if (recommendations?.categoryInfoList) {
            const allStreamers: Array<{ streamerId: string; streamId: string; masterListUrl: string; firstName: string; isFollowing: boolean }> = [];

            for (const category of recommendations.categoryInfoList) {
                if (category.streamInfoList?.streamDetails) {
                    for (const detail of category.streamInfoList.streamDetails) {
                        if (detail.anchor?.encryptedAccountId && detail.stream?.masterListUrl && detail.stream?.id) {
                            const streamerId = detail.anchor.encryptedAccountId;
                            if (!blockList.includes(streamerId)) {
                                allStreamers.push({
                                    streamerId,
                                    streamId: detail.stream.id || "",
                                    masterListUrl: detail.stream.masterListUrl,
                                    firstName: detail.anchor.firstName || "...",
                                    isFollowing: category.tag === "following",
                                });
                            }
                        }
                    }
                }
            }

            const streamerIds = allStreamers.map((s) => s.streamerId);
            const aliases = streamerIds.length > 0 ? await fetchAliasesInBatch(streamerIds) : {};

            for (const s of allStreamers) {
                const profileData = aliases?.[s.streamerId];
                const streamer: TlStreamer = {
                    streamerId: s.streamerId,
                    streamId: s.streamId,
                    alias: profileData?.alias || s.streamerId,
                    firstName: profileData?.firstName || s.firstName,
                    masterListUrl: s.masterListUrl,
                    isFollowing: s.isFollowing,
                };

                if (s.isFollowing) {
                    following.push(streamer);
                } else {
                    recommended.push(streamer);
                }
            }
        }

        return { following, recommended };
    } catch (error) {
        logger.error("[TL] Failed to fetch streamers", { error: (error as Error).message });
        return { following: [], recommended: [] };
    }
}

export async function fetchAliasesInBatch(streamerIds: string[]): Promise<Record<string, ProfileData> | null> {
    if (streamerIds.length === 0) return {};
    try {
        const headers = getApiHeaders();
        headers["Content-Type"] = "application/json";
        const url = `${API_BASE}/profiles/v2/batch?basicProfile=true&liveStats=false&followStats=false`;
        const response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(streamerIds),
        });
        if (!response.ok) return null;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body = (await response.json()) as Record<string, any>;
        const resultMap: Record<string, ProfileData> = {};

        for (const streamerId of Object.keys(body)) {
            const profile = body[streamerId]?.basicProfile;
            if (profile) {
                resultMap[streamerId] = {
                    alias: profile.aliases?.[0]?.alias || null,
                    firstName: profile.firstName || null,
                };
            }
        }
        return resultMap;
    } catch (error) {
        logger.error("[TL] Failed to fetch aliases in batch", { error: (error as Error).message });
        return null;
    }
}

export async function fetchMultiBroadcastStreamers(streamId: string): Promise<TlStreamer[]> {
    try {
        const headers = getApiHeaders();
        headers["Content-Type"] = "text/plain";

        const [watchResponse, blockList] = await Promise.all([
            fetch(`${API_BASE}/live/stream/v2/watch?requestId=`, {
                method: "POST",
                headers,
                body: streamId,
            }),
            fetchBlockList(),
        ]);

        if (!watchResponse.ok) {
            logger.error(`[TL] Multi-broadcast request failed: ${watchResponse.status}`);
            return [];
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = (await watchResponse.json()) as any;
        const streams = data?.multiBroadcast?.streams;
        if (!Array.isArray(streams) || streams.length === 0) return [];

        const rawStreamers: Array<{ streamerId: string; streamId: string; masterListUrl: string }> = [];
        for (const item of streams) {
            const accountId = item.stream?.mbDescriptor?.accountId;
            const mbStreamId = item.stream?.mbDescriptor?.streamId;
            const streamURL = item.stream?.streamURL;
            if (accountId && mbStreamId && streamURL && !blockList.includes(accountId)) {
                rawStreamers.push({ streamerId: accountId, streamId: mbStreamId, masterListUrl: streamURL });
            }
        }

        if (rawStreamers.length === 0) return [];

        // Exclude the parent streamer from co-streamers
        const filtered = rawStreamers.filter((s) => s.streamId !== streamId);

        if (filtered.length === 0) return [];

        const aliases = await fetchAliasesInBatch(filtered.map((s) => s.streamerId));

        return filtered.map((s) => {
            const profileData = aliases?.[s.streamerId];
            return {
                streamerId: s.streamerId,
                streamId: s.streamId,
                alias: profileData?.alias || s.streamerId,
                firstName: profileData?.firstName || "...",
                masterListUrl: s.masterListUrl,
                isFollowing: false,
            };
        });
    } catch (error) {
        logger.error("[TL] Failed to fetch multi-broadcast streamers", { error: (error as Error).message });
        return [];
    }
}

const DISCOVERY_BASE = "https://gateway.tango.me/discovery/v3";

export async function resolveAlias(alias: string): Promise<{ accountId: string; firstName: string } | null> {
    try {
        const headers = getApiHeaders();
        headers["Content-Type"] = "application/json";
        const url = `${API_BASE}/profiles/v2/batch?basicProfile=true&liveStats=false&followStats=false`;
        const response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify([alias]),
        });
        if (!response.ok) return null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body = (await response.json()) as Record<string, any>;
        const key = Object.keys(body)[0];
        if (!key) return null;
        return {
            accountId: body[key].encryptedAccountId || key,
            firstName: body[key].basicProfile?.firstName || "",
        };
    } catch (error) {
        logger.error("[TL] Failed to resolve alias", { alias, error: (error as Error).message });
        return null;
    }
}

export async function fetchFollowingList(): Promise<{ accountId: string; firstName: string }[]> {
    try {
        const headers = getApiHeaders();
        const all: { accountId: string; firstName: string }[] = [];
        let cursor = "";
        for (let page = 0; page < 20; page++) {
            const url = cursor
                ? `${DISCOVERY_BASE}/followings/me/list?size=50&cursor=${cursor}`
                : `${DISCOVERY_BASE}/followings/me/list?size=50`;
            const response = await fetch(url, { headers });
            if (!response.ok) break;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const data = (await response.json()) as any;
            if (Array.isArray(data.followers)) {
                for (const f of data.followers) {
                    all.push({
                        accountId: f.accountId,
                        firstName: f.profileDetails?.firstName || "",
                    });
                }
            }
            if (!data.nextCursor) break;
            cursor = data.nextCursor;
        }
        logger.info(`[TL] Fetched following list: ${all.length} accounts`);
        return all;
    } catch (error) {
        logger.error("[TL] Failed to fetch following list", { error: (error as Error).message });
        return [];
    }
}

export async function follow(streamerId: string): Promise<boolean> {
    try {
        const headers = getApiHeaders();
        const response = await fetch(`${API_BASE}/follow/add`, {
            method: "POST",
            headers,
            body: streamerId,
        });
        return response.ok;
    } catch {
        return false;
    }
}

export async function unfollow(streamerId: string): Promise<boolean> {
    try {
        const headers = getApiHeaders();
        const response = await fetch(`${API_BASE}/follow/remove`, {
            method: "POST",
            headers,
            body: streamerId,
        });
        return response.ok;
    } catch {
        return false;
    }
}

export async function block(streamerId: string): Promise<boolean> {
    try {
        const headers = getApiHeaders();
        const response = await fetch(`${API_BASE}/blockList?accountId=${streamerId}`, {
            method: "POST",
            headers,
        });
        if (response.ok) {
            blockListCache = null;
        }
        return response.ok;
    } catch {
        return false;
    }
}
