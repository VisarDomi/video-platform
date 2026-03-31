import logger from "../../core/logger.js";
import { readTokens } from "shared";

const API_BASE = "https://gateway.tango.me/proxycador/api/public/v1";

interface ProfileData {
    alias: string | null;
    firstName: string | null;
}

async function getApiHeaders(): Promise<Record<string, string> | null> {
    const tokens = await readTokens();
    if (!tokens?.st) return null;
    return {
        cookie: `Tango-ST=${tokens.st}`,
        Accept: "application/json",
    };
}

export async function fetchAliasesInBatch(streamerIds: string[]): Promise<Record<string, ProfileData> | null> {
    const headers = await getApiHeaders();
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
    const headers = await getApiHeaders();
    if (!headers) return null;

    try {
        const url = `${API_BASE}/profiles/v2/batch?basicProfile=true&liveStats=false&followStats=false`;
        const response = await fetch(url, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify([alias]),
        });

        if (!response.ok) return null;
        const body: any = await response.json();
        const key = Object.keys(body)[0];
        if (!key) return null;

        return {
            accountId: body[key].encryptedAccountId || key,
            firstName: body[key].basicProfile?.firstName || "",
        };
    } catch (error) {
        logger.error("[Tango] Failed to resolve alias", { alias, error: (error as Error).message });
        return null;
    }
}
