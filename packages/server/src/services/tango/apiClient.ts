import logger from "../../core/logger.js";
import { readTokens } from "shared";
import { extractAliasSnapshot } from "./profileAliases.js";
import type { AliasSnapshot } from "../aliasRegistry.js";

const API_BASE = "https://gateway.tango.me/proxycador/api/public/v1";
const FOLLOWINGS_URL = "https://gateway.tango.me/discovery/v3/followings/me/list?size=5000";

export interface ProfileData {
    alias: string | null;
    aliases: AliasSnapshot | null;
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
                const aliases = extractAliasSnapshot(profile);
                result[id] = {
                    alias: aliases?.current ?? null,
                    aliases,
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

export async function followAccount(streamerId: string): Promise<void> {
    const headers = await getApiHeaders();
    if (!headers) throw new Error("Tango authentication is unavailable");

    const response = await fetch(`${API_BASE}/follow/add`, {
        method: "POST",
        headers,
        body: streamerId,
    });
    if (!response.ok) {
        throw new Error(`Tango follow failed: ${response.status}`);
    }
}

export async function fetchFollowingAccountIds(): Promise<string[] | null> {
    const headers = await getApiHeaders();
    if (!headers) return null;

    try {
        const response = await fetch(FOLLOWINGS_URL, { headers });
        if (!response.ok) return null;
        const data: any = await response.json();
        if (!Array.isArray(data?.followers)) return null;
        return data.followers
            .map((follower: any) => follower?.accountId)
            .filter((accountId: unknown): accountId is string => typeof accountId === "string");
    } catch (error) {
        logger.error("[Tango] Failed to fetch followings", { error: (error as Error).message });
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
