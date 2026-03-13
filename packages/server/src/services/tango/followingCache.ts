import pLimit from "p-limit";
import logger from "../../core/logger.js";
import * as tangoApi from "./apiClient.js";

const cacheLock = pLimit(1);

// alias → accountId
let aliasToAccount = new Map<string, string>();
// Set of followed aliases
let followedAliases = new Set<string>();
let initialized = false;

export function getFollowedAliases(): Promise<Set<string>> {
    return cacheLock(async () => {
        if (!initialized) await refresh();
        return followedAliases;
    });
}

export async function refresh(): Promise<void> {
    try {
        const followers = await tangoApi.fetchFollowingList();
        const accountIds = followers.map(f => f.accountId);

        // Batch-resolve accountIds to aliases
        const profiles = accountIds.length > 0
            ? await tangoApi.fetchAliasesInBatch(accountIds)
            : {};

        const nextAliasToAccount = new Map<string, string>();
        const nextFollowed = new Set<string>();

        if (profiles) {
            for (const accountId of Object.keys(profiles)) {
                const alias = profiles[accountId].alias;
                if (alias) {
                    nextAliasToAccount.set(alias, accountId);
                    nextFollowed.add(alias);
                }
            }
        }

        aliasToAccount = nextAliasToAccount;
        followedAliases = nextFollowed;
        initialized = true;
        logger.info(`[TL:cache] Following cache refreshed: ${followedAliases.size} aliases`);
    } catch (error) {
        logger.error("[TL:cache] Failed to refresh", { error: (error as Error).message });
    }
}

export function resolveAndFollow(alias: string): Promise<boolean> {
    return cacheLock(async () => {
        let accountId = aliasToAccount.get(alias);
        if (!accountId) {
            const resolved = await tangoApi.resolveAlias(alias);
            if (!resolved) return false;
            accountId = resolved.accountId;
            aliasToAccount.set(alias, accountId);
        }
        const ok = await tangoApi.follow(accountId);
        if (ok) followedAliases.add(alias);
        return ok;
    });
}

export function resolveAndUnfollow(alias: string): Promise<boolean> {
    return cacheLock(async () => {
        let accountId = aliasToAccount.get(alias);
        if (!accountId) {
            const resolved = await tangoApi.resolveAlias(alias);
            if (!resolved) return false;
            accountId = resolved.accountId;
            aliasToAccount.set(alias, accountId);
        }
        const ok = await tangoApi.unfollow(accountId);
        if (ok) followedAliases.delete(alias);
        return ok;
    });
}
