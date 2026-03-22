import logger from "../../core/logger.js";
import { getTokens } from "./tokenManager.js";

const API_BASE = "https://gateway.tango.me/proxycador/api/public/v1";

interface ProfileData {
    alias: string | null;
    firstName: string | null;
}

function getApiHeaders(): Record<string, string> | null {
    const tokens = getTokens();
    if (!tokens?.st) return null;
    return {
        cookie: `Tango-ST=${tokens.st}`,
        Accept: "application/json",
    };
}

export async function fetchAliasesInBatch(streamerIds: string[]): Promise<Record<string, ProfileData> | null> {
    const headers = getApiHeaders();
    if (!headers) return null;

    try {
        const url = `${API_BASE}/profiles/v2/batch?basicProfile=true&liveStats=false&followStats=false`;
        const response = await fetch(url, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify(streamerIds),
        });

        if (!response.ok) return null;
        const data: any = await response.json();

        const result: Record<string, ProfileData> = {};
        for (const id in data) {
            const profile = data[id]?.basicProfile;
            if (profile) {
                result[id] = {
                    alias: profile.aliases?.[0]?.alias ?? null,
                    firstName: profile.firstName ?? null,
                };
            }
        }
        return result;
    } catch (error) {
        logger.error("[Tango] Failed to fetch aliases in batch", { error: (error as Error).message });
        return null;
    }
}

export async function resolveAlias(alias: string): Promise<{ accountId: string; firstName: string } | null> {
    const headers = getApiHeaders();
    if (!headers) return null;

    try {
        const url = `https://gateway.tango.me/discovery/v2/search?query=${encodeURIComponent(alias)}&size=5`;
        const response = await fetch(url, { headers });

        if (!response.ok) return null;
        const data: any = await response.json();

        const hits = data?.searchResults || [];
        for (const hit of hits) {
            const hitAlias = hit?.basicProfile?.aliases?.[0]?.alias;
            if (hitAlias?.toLowerCase() === alias.toLowerCase()) {
                return {
                    accountId: hit.basicProfile.encryptedAccountId,
                    firstName: hit.basicProfile.firstName || alias,
                };
            }
        }
        return null;
    } catch (error) {
        logger.error("[Tango] Failed to resolve alias", { alias, error: (error as Error).message });
        return null;
    }
}
