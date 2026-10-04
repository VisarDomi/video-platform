import os from "node:os";
import path from "node:path";

// The single source of truth for the capture/processed folder layout:
//     <downloadsRoot>/<provider>/<downloaded|edited|trash>
// Every package (server, downloader, pipeline) derives its roots from here.

export type VideoFolderKind = "downloaded" | "edited" | "trash";

export const VIDEO_FOLDER_KINDS = ["downloaded", "edited", "trash"] as const;

export const downloadsRoot = process.env.VIDEO_DOWNLOADS_ROOT
    ?? path.join(os.homedir(), "Videos", "downloads");

export function providerFolder(provider: string, kind: VideoFolderKind): string {
    return path.join(downloadsRoot, provider, kind);
}

export function providerFolders(provider: string): Readonly<Record<VideoFolderKind, string>> {
    return {
        downloaded: providerFolder(provider, "downloaded"),
        edited: providerFolder(provider, "edited"),
        trash: providerFolder(provider, "trash"),
    };
}

// The services' own data lives outside any checkout, so deleting and re-cloning the
// repository loses nothing.
export const servicesDataRoot = process.env.VIDEO_SERVICES_DATA_ROOT
    ?? path.join(os.homedir(), ".local", "share", "video-services");

// Each provider's download list (the streamers to record): the server edits it, the downloader
// watches it. `<data root>/download-lists/<provider>.txt`.
export function downloadListPath(provider: "tango" | "fc2" | "sc"): string {
    return path.join(servicesDataRoot, "download-lists", `${provider}.txt`);
}
