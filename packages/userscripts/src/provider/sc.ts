import type { DownloadListAdapter } from "../core/downloadListBar";

const NON_STREAMER_EXACT = new Set(["", "favorites", "search", "categories", "tags", "models", "couple", "trans", "male", "female"]);
const NON_STREAMER_PREFIXES = new Set(["girls"]);

// Stripchat pages identify streamers by the username in the first path
// segment; known non-streamer routes hide the bar.
export const sc: DownloadListAdapter = {
    apiPath: "/api/sc",
    identify(): string | null {
        const parts = location.pathname.split("/").filter(Boolean);
        if (parts.length === 0) return null;
        const first = parts[0].toLowerCase();
        if (NON_STREAMER_EXACT.has(first) || NON_STREAMER_PREFIXES.has(first)) return null;
        return parts[0];
    },
};
