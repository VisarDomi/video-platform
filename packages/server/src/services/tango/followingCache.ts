import logger from "../../core/logger.js";
import * as tangoApi from "./apiClient.js";

// alias → accountId
let aliasToAccount = new Map<string, string>();
// Set of followed aliases
let followedAliases = new Set<string>();
let initialized = false;

export async function getFollowedAliases(): Promise<Set<string>> {
    if (!initialized) await refresh();
    return followedAliases;
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

export async function resolveAndFollow(alias: string): Promise<boolean> {
    // Try cache first, then resolve via API
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
}

export async function resolveAndUnfollow(alias: string): Promise<boolean> {
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
}
