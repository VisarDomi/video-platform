import { promises as fs } from "fs";
import { readTokens } from "shared";
import { AliasRegistry } from "./aliasRegistry.js";
import type { AliasFetcher } from "./aliasRegistry.js";
import { ALIASES_PATH, TANGO_FILE_PATH } from "../core/config.js";
import logger from "../core/logger.js";
import { extractAliasSnapshot } from "./tango/profileAliases.js";
import { fetchFollowingAccountIds } from "./tango/apiClient.js";

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

export function parseTangoTargetIds(content: string): string[] {
    const ids = new Set<string>();
    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || !trimmed.startsWith("https://tango.me/")) continue;
        const rest = trimmed.slice("https://tango.me/".length);
        const spaceIdx = rest.indexOf(" ");
        const accountId = (spaceIdx === -1 ? rest : rest.slice(0, spaceIdx)).trim();
        if (accountId) ids.add(accountId);
    }
    return [...ids];
}

export function combineAliasRefreshIds(followingIds: string[], targetIds: string[]): string[] {
    return [...new Set([...followingIds, ...targetIds])];
}

async function getAllAliasRefreshIds(): Promise<string[]> {
    const [followingIds, targetContent] = await Promise.all([
        fetchFollowingAccountIds().then(ids => ids ?? []),
        fs.readFile(TANGO_FILE_PATH, "utf-8").catch(() => ""),
    ]);
    const targetIds = parseTangoTargetIds(targetContent);
    return combineAliasRefreshIds(followingIds, targetIds);
}

const fetcher: AliasFetcher = async (ids: string[]) => {
    const headers = await getApiHeaders();
    if (!headers) return {};

    const result: Awaited<ReturnType<AliasFetcher>> = {};

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
                const aliases = extractAliasSnapshot(batch[id]?.basicProfile);
                if (aliases) result[id] = aliases;
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
            getAllAliasRefreshIds,
            fetcher,
            TANGO_FILE_PATH,
        );
    };

    void boot();
}
