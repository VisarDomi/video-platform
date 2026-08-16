import { promises as fsPromises } from "fs";
import path from "path";
import * as types from "../../core/types.js";
import * as config from "../../core/config.js";
import * as constants from "../../core/constants.js";
import { getDurationsFromGo } from "../../core/playlist-daemon.js";

export async function getAllVideos(provider: string = "tango", after?: string): Promise<types.VideoItem[]> {
    const paths = config.getProviderPaths(provider);
    const providerPaths = [
        { path: path.join(paths.downloaded, ".active"), type: constants.ALL_VIDEO_PATHS_TYPES.ORIGINAL, isLive: true },
        { path: paths.downloaded, type: constants.ALL_VIDEO_PATHS_TYPES.ORIGINAL, isLive: false },
        { path: paths.edited, type: constants.ALL_VIDEO_PATHS_TYPES.EDITED, isLive: false },
    ];

    const allEntries: { name: string; fullPath: string; type: types.VideoType; isLive: boolean; playlistPath?: string }[] = [];

    await Promise.all(providerPaths.map(async (dirConfig) => {
        try {
            const entries = await fsPromises.readdir(dirConfig.path, { withFileTypes: true });
            entries.forEach(entry => {
                if (entry.isDirectory() && !entry.name.startsWith(".")) {
                    allEntries.push({
                        name: entry.name,
                        fullPath: path.join(dirConfig.path, entry.name),
                        type: dirConfig.type,
                        isLive: dirConfig.isLive,
                    });
                }
            });
        } catch (error) {
        }
    }));

    const visibleEntries = (await Promise.all(allEntries.map(async (entry) => {
        if (!entry.isLive) return entry;
        try {
            await fsPromises.access(path.join(entry.fullPath, constants.FILE_NAMES.HLS_PLAYLIST));
            return entry;
        } catch {
            return null;
        }
    }))).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    const entriesToProcess = after
        ? visibleEntries.filter(entry => entry.name > after)
        : visibleEntries;

    const pathsToProcess: string[] = [];
    const entryMap = new Map<string, typeof allEntries[0]>();

    entriesToProcess.forEach(entry => {
        if (!entry.isLive) {
            const playlistPath = path.join(entry.fullPath, constants.FILE_NAMES.HLS_PLAYLIST);
            entry.playlistPath = playlistPath;
            pathsToProcess.push(playlistPath);
            entryMap.set(playlistPath, entry);
        }
    });

    const durationMap = await getDurationsFromGo(pathsToProcess);

    const videos: types.VideoItem[] = entriesToProcess.map(entry => {
        let duration = 0;

        if (entry.isLive) {
            duration = 0;
        } else if (entry.playlistPath && durationMap[entry.playlistPath] !== undefined) {
            duration = durationMap[entry.playlistPath];
        }

        return {
            filename: entry.name,
            type: entry.type,
            size: 0,
            duration: duration,
            isLive: entry.isLive
        };
    });

    videos.sort((a, b) => a.filename.localeCompare(b.filename));

    return videos;
}
