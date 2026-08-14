import { SC_FILE_PATH } from "../../core/config.js";
import { resolveScUsername } from "../../services/sc/apiClient.js";
import { createListRoutes, ListProviderAdapter } from "./list-routes.js";
import { formatStreamerTarget, parseStreamerTargetLine } from "shared";

function parseUsername(identifier: string): string {
    if (identifier.includes("stripchat.com/")) {
        const parts = identifier.split("stripchat.com/");
        if (parts[1]) return parts[1].split("/")[0].split("?")[0];
    }
    return identifier;
}

function parseRoomId(identifier: string): string | null {
    const trimmed = identifier.trim();
    if (/^\d+$/.test(trimmed)) return trimmed;
    if (trimmed.includes(" ")) {
        const parts = trimmed.split(" ");
        const maybeId = parts[parts.length - 1]?.trim();
        if (maybeId && /^\d+$/.test(maybeId)) return maybeId;
    }
    return null;
}

const adapter: ListProviderAdapter = {
    name: "sc",
    filePath: SC_FILE_PATH,

    parseLine(line: string) {
        const parsed = parseStreamerTargetLine("sc", line);
        return parsed ? { id: parsed.id, label: parsed.label } : null;
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
        return formatStreamerTarget({ provider: "sc", ...entry });
    },

    async resolveForRemove(identifier: string) {
        const roomId = parseRoomId(identifier);
        if (roomId) return roomId;

        const username = parseUsername(identifier);
        const resolved = await resolveScUsername(username);
        return resolved?.roomId || username;
    },
};

export default createListRoutes(adapter);
