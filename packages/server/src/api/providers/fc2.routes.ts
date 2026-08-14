import { FC2_FILE_PATH } from "../../core/config.js";
import { createListRoutes, ListProviderAdapter } from "./list-routes.js";
import { formatStreamerTarget, parseStreamerTargetLine } from "shared";

const adapter: ListProviderAdapter = {
    name: "fc2",
    filePath: FC2_FILE_PATH,

    parseLine(line: string) {
        const parsed = parseStreamerTargetLine("fc2", line);
        return parsed ? { id: parsed.id, label: parsed.label } : null;
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
        return formatStreamerTarget({ provider: "fc2", ...entry });
    },
};

export default createListRoutes(adapter);
