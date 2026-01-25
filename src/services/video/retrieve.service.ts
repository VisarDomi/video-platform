import { promises as fsPromises } from "fs";
import path from "path";
import * as types from "../../core/types.js";
import * as config from "../../core/config.js";
import * as utils from "../../core/utils.js";
import * as constants from "../../core/constants.js";

export async function getAllVideos(provider: string = "tango"): Promise<{ videos: types.VideoItem[], timings: Record<string, number> }> {
    const timings: Record<string, number> = {};
    const tStart = Date.now();

    const liveFolders = await utils.getLiveFolders();
    timings['live-folders'] = Date.now() - tStart;

    const paths = config.getProviderPaths(provider);
    const providerPaths = [
        { path: paths.downloader, type: constants.ALL_VIDEO_PATHS_TYPES.ORIGINAL },
        { path: paths.edited, type: constants.ALL_VIDEO_PATHS_TYPES.EDITED },
        { path: paths.converted, type: constants.ALL_VIDEO_PATHS_TYPES.EDITED },
    ];

    // Phase 1: Readdir (Listing all folders)
    const tReaddirStart = Date.now();
    const allEntries: { name: string; fullPath: string; type: types.VideoType }[] = [];

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
    timings['readdir'] = Date.now() - tReaddirStart;

    // Phase 2: Processing (Reading durations)
    const tProcessStart = Date.now();
    const videos: types.VideoItem[] = await Promise.all(allEntries.map(async (entry) => {
        const isLive = liveFolders.has(entry.name);
        // Only read duration if not live
        const duration = isLive ? 0 : await utils.getPlaylistDuration(entry.fullPath);

        return {
            filename: entry.name,
            type: entry.type,
            size: 0,
            duration: duration,
            isLive: isLive
        };
    }));
    timings['duration-calc'] = Date.now() - tProcessStart;

    // Phase 3: Sorting
    const tSortStart = Date.now();
    videos.sort((a, b) => a.filename.localeCompare(b.filename));
    timings['sorting'] = Date.now() - tSortStart;

    // Stats
    timings['count'] = videos.length;

    return { videos, timings };
}