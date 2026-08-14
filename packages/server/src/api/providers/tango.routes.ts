import { promises as fs } from "fs";
import { TANGO_FILE_PATH } from "../../core/config.js";
import {
    resolveAlias,
    fetchAliasesInBatch,
    followAccount,
    fetchFollowingAccountIds,
} from "../../services/tango/apiClient.js";
import type { ProfileData } from "../../services/tango/apiClient.js";
import type { AliasSnapshot } from "../../services/aliasRegistry.js";
import { registry } from "../../services/aliasRefreshService.js";
import { createListRoutes, ListProviderAdapter } from "./list-routes.js";
import {
    formatStreamerTarget,
    parseStreamerTargetLine,
    targetMembershipIdentifiers,
} from "shared";

const PREFIX = "https://tango.me/";

function parseAccountId(identifier: string): string | null {
    const trimmed = identifier.trim();
    if (trimmed.startsWith(PREFIX)) {
        const rest = trimmed.slice(PREFIX.length);
        const accountId = rest.split(" ")[0]?.trim();
        return accountId || null;
    }
    return null;
}

interface TangoAliasLookup {
    resolve(streamerId: string): string | undefined;
    getAllWithHistory(): Record<string, string[]>;
    getReverse(): Record<string, string>;
    mergeAliasSnapshot(streamerId: string, aliases: AliasSnapshot): Promise<boolean>;
}

interface TangoApi {
    resolveAlias(alias: string): Promise<{ accountId: string; firstName: string } | null>;
    fetchAliasesInBatch(streamerIds: string[]): Promise<Record<string, ProfileData> | null>;
    fetchFollowingAccountIds(): Promise<string[] | null>;
    followAccount(streamerId: string): Promise<void>;
}

const tangoApi: TangoApi = {
    resolveAlias,
    fetchAliasesInBatch,
    fetchFollowingAccountIds,
    followAccount,
};

export function createTangoAdapter(
    filePath: string = TANGO_FILE_PATH,
    aliasLookup: TangoAliasLookup = registry,
    api: TangoApi = tangoApi,
): ListProviderAdapter {
    const adapter: ListProviderAdapter = {
        name: "tango",
        filePath,

        parseLine(line: string) {
            const parsed = parseStreamerTargetLine("tango", line);
            return parsed ? { id: parsed.id, label: parsed.label } : null;
        },

        isResolved(line: string) {
            return this.parseLine(line) !== null;
        },

        async resolveIdentifier(input: string) {
            const trimmed = input.trim();
            const reverse = aliasLookup.getReverse();
            let accountId = parseAccountId(trimmed)
                ?? reverse[trimmed]
                ?? (aliasLookup.resolve(trimmed) ? trimmed : null);

            if (!accountId) {
                const resolved = await api.resolveAlias(trimmed);
                if (!resolved) return null;
                accountId = resolved.accountId;
            }

            const profiles = await api.fetchAliasesInBatch([accountId]);
            const profile = profiles?.[accountId];
            if (!profile?.alias || !profile.aliases) return null;
            await aliasLookup.mergeAliasSnapshot(accountId, profile.aliases);
            return { id: accountId, label: profile.alias };
        },

        async beforeAdd(entry) {
            const followingIds = await api.fetchFollowingAccountIds();
            if (!followingIds) throw new Error("Could not verify Tango follow state");
            if (!followingIds.includes(entry.id)) {
                await api.followAccount(entry.id);
            }
        },

        formatEntry(entry) {
            return formatStreamerTarget({ provider: "tango", ...entry });
        },

        enrichList(parsed) {
            const allAliases = aliasLookup.getAllWithHistory();
            const identifiers = new Set<string>();
            for (const { id, label } of parsed) {
                for (const identifier of targetMembershipIdentifiers(
                    { provider: "tango", id, label },
                    allAliases[id] ?? [],
                )) identifiers.add(identifier);
            }
            return [...identifiers];
        },

        async resolveForRemove(identifier: string) {
            const accountId = parseAccountId(identifier);
            if (accountId) return accountId;

            const reverse = aliasLookup.getReverse();
            if (reverse[identifier]) return reverse[identifier];

            try {
                const content = await fs.readFile(filePath, "utf-8");
                for (const line of content.split("\n")) {
                    const parsed = adapter.parseLine(line);
                    if (parsed?.label === identifier) {
                        return parsed.id;
                    }
                }
            } catch {
            }

            return identifier;
        },
    };

    return adapter;
}

const adapter = createTangoAdapter();
export default createListRoutes(adapter);
