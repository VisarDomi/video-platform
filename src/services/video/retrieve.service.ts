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

    const videos: types.VideoItem[] = [];
    const paths = config.getProviderPaths(provider);
    const providerPaths = [
        { path: paths.downloader, type: constants.ALL_VIDEO_PATHS_TYPES.ORIGINAL },
        { path: paths.edited, type: constants.ALL_VIDEO_PATHS_TYPES.EDITED },
        { path: paths.converted, type: constants.ALL_VIDEO_PATHS_TYPES.EDITED },
    ];

    const tProcessStart = Date.now();

    // Process all video directories in parallel
    const dirPromises = providerPaths.map(async (dirConfig) => {
        try {
            const entries = await fsPromises.readdir(dirConfig.path, { withFileTypes: true });

            // Map entries to VideoItems in parallel
            const folderPromises = entries
                .filter(entry => entry.isDirectory())
                .map(async (entry) => {
                    const fullPath = path.join(dirConfig.path, entry.name);
                    const isLive = liveFolders.has(entry.name);

                    // Only read duration if not live (live duration changes constantly)
                    const duration = isLive ? 0 : await utils.getPlaylistDuration(fullPath);

                    return {
                        filename: entry.name,
                        type: dirConfig.type,
                        size: 0, // Calculation skipped for performance
                        duration: duration,
                        isLive: isLive
                    };
                });

            const dirVideos = await Promise.all(folderPromises);
            videos.push(...dirVideos);
        } catch (error) {
            // Directory might not exist or be inaccessible, just skip it
        }
    });

    await Promise.all(dirPromises);
    timings['processing-files'] = Date.now() - tProcessStart;

    const tSortStart = Date.now();
    videos.sort((a, b) => a.filename.localeCompare(b.filename));
    timings['sorting'] = Date.now() - tSortStart;

    return { videos, timings };
}