import { promises as fsPromises } from "fs";
import path from "path";
import * as types from "../../core/types.js";
import * as config from "../../core/config.js";
import * as utils from "../../core/utils.js";
import * as constants from "../../core/constants.js";
import { getDurationsFromGo } from "../../core/playlist-daemon.js";
import { getAllMp4Videos } from "./mp4-retrieve.service.js";

export async function getAllVideos(provider: string = "tango", after?: string): Promise<types.VideoItem[]> {
    // tl provider uses /api/tl/streams instead
    if (provider === "tl") return [];

    // mp4 provider uses flat files, not HLS directories
    if (provider === "mp4") return getAllMp4Videos(provider, after);

    const liveFolders = await utils.getLiveFolders();

    const paths = config.getProviderPaths(provider);
    const providerPaths = [
        { path: paths.downloader, type: constants.ALL_VIDEO_PATHS_TYPES.ORIGINAL },
        { path: paths.edited, type: constants.ALL_VIDEO_PATHS_TYPES.EDITED },
        { path: paths.converted, type: constants.ALL_VIDEO_PATHS_TYPES.EDITED },
    ];

    const allEntries: { name: string; fullPath: string; type: types.VideoType; playlistPath?: string }[] = [];

    await Promise.all(providerPaths.map(async (dirConfig) => {
        try {
            const entries = await fsPromises.readdir(dirConfig.path, { withFileTypes: true });
            entries.forEach(entry => {
                if (entry.isDirectory()) {
                    allEntries.push({
                        name: entry.name,
                        fullPath: path.join(dirConfig.path, entry.name),
                        type: dirConfig.type
                    });
                }
            });
        } catch (error) {
            // Directory might not exist or be inaccessible
        }
    }));

    // Filter to only new entries when polling
    const entriesToProcess = after
        ? allEntries.filter(entry => entry.name > after)
        : allEntries;

    // Prepare list for Go
    const pathsToProcess: string[] = [];
    // Map to quickly find entry by path to assign duration later
    const entryMap = new Map<string, typeof allEntries[0]>();

    entriesToProcess.forEach(entry => {
        const isLive = liveFolders.has(entry.name);
        if (!isLive) {
            const playlistPath = path.join(entry.fullPath, constants.FILE_NAMES.HLS_PLAYLIST);
            entry.playlistPath = playlistPath;
            pathsToProcess.push(playlistPath);
            entryMap.set(playlistPath, entry);
        }
    });

    // Call Go
    const durationMap = await getDurationsFromGo(pathsToProcess);

    const videos: types.VideoItem[] = entriesToProcess.map(entry => {
        const isLive = liveFolders.has(entry.name);
        let duration = 0;

        if (isLive) {
            duration = 0;
        } else if (entry.playlistPath && durationMap[entry.playlistPath] !== undefined) {
            duration = durationMap[entry.playlistPath];
        }

        return {
            filename: entry.name,
            type: entry.type,
            size: 0,
            duration: duration,
            isLive: isLive
        };
    });

    videos.sort((a, b) => a.filename.localeCompare(b.filename));

    return videos;
}