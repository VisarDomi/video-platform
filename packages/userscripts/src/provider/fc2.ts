import type { DownloadListAdapter } from "../core/downloadListBar";

// fc2 live pages identify streamers by the numeric ID in the path.
export const fc2: DownloadListAdapter = {
    apiPath: "/api/fc2",
    identify(): string | null {
        const match = location.pathname.match(/\/(\d+)\/?/);
        return match ? match[1] : null;
    },
};
