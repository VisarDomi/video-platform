import { SC_FILE_PATH } from "../../core/config.js";
import { resolveScUsername } from "../../services/sc/apiClient.js";
import { createListRoutes, ListProviderAdapter } from "./list-routes.js";

const PREFIX = "https://stripchat.com/";

function parseUsername(identifier: string): string {
    if (identifier.includes("stripchat.com/")) {
        const parts = identifier.split("stripchat.com/");
        if (parts[1]) return parts[1].split("/")[0].split("?")[0];
    }
    return identifier;
}

const adapter: ListProviderAdapter = {
    name: "sc",
    filePath: SC_FILE_PATH,

    parseLine(line: string) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || !trimmed.startsWith(PREFIX)) return null;
        const rest = trimmed.slice(PREFIX.length);
        const spaceIdx = rest.indexOf(" ");
        if (spaceIdx === -1) return { id: rest.replace(/\/$/, ""), label: rest.replace(/\/$/, "") };
        return { id: rest.slice(spaceIdx + 1), label: rest.slice(0, spaceIdx) };
    },

    isResolved(line: string) {
        const parsed = this.parseLine(line);
        return parsed !== null && parsed.id !== parsed.label;
    },

    async resolveIdentifier(input: string) {
        const username = parseUsername(input);
        const resolved = await resolveScUsername(username);
        if (!resolved) return null;
        return { id: resolved.roomId, label: resolved.username };
    },

    formatEntry(entry) {
        return `${PREFIX}${entry.label} ${entry.id}`;
    },
};

export default createListRoutes(adapter);
