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
