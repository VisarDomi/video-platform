import { readTokens } from "shared";
import { AliasRegistry } from "./aliasRegistry.js";
import type { AliasFetcher } from "./aliasRegistry.js";
import { ALIASES_PATH, TANGO_FILE_PATH } from "../core/config.js";
import logger from "../core/logger.js";

const ALIAS_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const BATCH_CHUNK_SIZE = 500;

const API_BASE = "https://gateway.tango.me";

async function getApiHeaders(): Promise<Record<string, string> | null> {
    const tokens = await readTokens();
    if (!tokens?.st) return null;
    return {
        cookie: `Tango-ST=${tokens.st}`,
        Accept: "application/json",
    };
}

async function getAllFollowingIds(): Promise<string[]> {
    const headers = await getApiHeaders();
    if (!headers) return [];

    try {
        const response = await fetch(
            `${API_BASE}/discovery/v3/followings/me/list?size=5000`,
            { headers },
        );
        if (!response.ok) return [];
        const data: any = await response.json();
        if (!data?.followers) return [];
        return data.followers.map((f: any) => f.accountId);
    } catch (error: any) {
        logger.error("[AliasRefresh] Failed to fetch followings", { error: error.message });
        return [];
    }
}

const fetcher: AliasFetcher = async (ids: string[]) => {
    const headers = await getApiHeaders();
    if (!headers) return {};

    const result: Record<string, string> = {};

    for (let i = 0; i < ids.length; i += BATCH_CHUNK_SIZE) {
        const chunk = ids.slice(i, i + BATCH_CHUNK_SIZE);
        try {
            const response = await fetch(
                `${API_BASE}/proxycador/api/public/v1/profiles/v2/batch?basicProfile=true&liveStats=false&followStats=false`,
                {
                    method: "POST",
                    headers: { ...headers, "Content-Type": "application/json" },
                    body: JSON.stringify(chunk),
                },
            );
            if (!response.ok) continue;
            const batch: any = await response.json();
            for (const id of chunk) {
                const alias = batch[id]?.basicProfile?.aliases?.[0]?.alias;
                if (alias) result[id] = alias;
            }
        } catch (error: any) {
            logger.error(`[AliasRefresh] Batch fetch failed for chunk ${i}`, { error: error.message });
        }
    }

    return result;
};

export const registry = new AliasRegistry(ALIASES_PATH);

export function startAliasRefresh(): void {
    const boot = async () => {
        await registry.load();
        registry.startPeriodicRefresh(
            ALIAS_REFRESH_INTERVAL_MS,
            getAllFollowingIds,
            fetcher,
            TANGO_FILE_PATH,
        );
    };

    void boot();
}
