import { FC2_FILE_PATH } from "../../core/config.js";
import { createListRoutes, ListProviderAdapter } from "./list-routes.js";

const PREFIX = "https://live.fc2.com/";
const SUFFIX = "/";

const adapter: ListProviderAdapter = {
    name: "fc2",
    filePath: FC2_FILE_PATH,

    parseLine(line: string) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || !trimmed.startsWith(PREFIX)) return null;
        let id = trimmed.slice(PREFIX.length);
        if (id.endsWith(SUFFIX)) id = id.slice(0, -SUFFIX.length);
        return { id, label: id };
    },

    isResolved(line: string) {
        return this.parseLine(line) !== null;
    },

    async resolveIdentifier(input: string) {
        const match = input.match(/(\d+)/);
        if (!match) return null;
        return { id: match[1], label: match[1] };
    },

    formatEntry(entry) {
        return `${PREFIX}${entry.id}${SUFFIX}`;
    },
};

export default createListRoutes(adapter);
