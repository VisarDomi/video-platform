import { TANGO_FILE_PATH } from "../core/config.js";
import { resolveAlias, fetchAliasesInBatch } from "../services/tango/apiClient.js";
import { registry } from "../services/aliasRefreshService.js";
import { createListRoutes, ListProviderAdapter } from "./list-routes.js";

const PREFIX = "https://tango.me/";

const adapter: ListProviderAdapter = {
    name: "tango",
    filePath: TANGO_FILE_PATH,

    parseLine(line: string) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || !trimmed.startsWith(PREFIX)) return null;
        const rest = trimmed.slice(PREFIX.length);
        const spaceIdx = rest.indexOf(" ");
        if (spaceIdx === -1) return null;
        return { id: rest.slice(0, spaceIdx), label: rest.slice(spaceIdx + 1) };
    },

    isResolved(line: string) {
        return this.parseLine(line) !== null;
    },

    async resolveIdentifier(input: string) {
        const resolved = await resolveAlias(input);
        if (!resolved) return null;
        const profiles = await fetchAliasesInBatch([resolved.accountId]);
        const latestAlias = profiles?.[resolved.accountId]?.alias || input;
        return { id: resolved.accountId, label: latestAlias };
    },

    formatEntry(entry) {
        return `${PREFIX}${entry.id} ${entry.label}`;
    },

    enrichList(parsed) {
        const allAliases = registry.getAllWithHistory();
        const identifiers = new Set<string>();
        for (const { id, label } of parsed) {
            identifiers.add(id);
            identifiers.add(label);
            const cached = allAliases[id];
            if (cached) {
                for (const a of cached) identifiers.add(a);
            }
        }
        return [...identifiers];
    },

    resolveForRemove(identifier: string) {
        const reverse = registry.getReverse();
        return reverse[identifier] || identifier;
    },
};

export default createListRoutes(adapter);
