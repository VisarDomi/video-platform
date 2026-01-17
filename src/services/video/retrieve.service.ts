import { promises as fsPromises } from "fs";
import path from "path";
import * as types from "../../core/types.js";
import * as config from "../../core/config.js";
import * as utils from "../../core/utils.js";

export async function getAllVideos(): Promise<types.VideoItem[]> {
    const liveFolders = await utils.getLiveFolders();
    const videos: types.VideoItem[] = [];

    // Process all video directories in parallel
    const dirPromises = config.ALL_VIDEO_PATHS.map(async (dirConfig) => {
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

    return videos.sort((a, b) => a.filename.localeCompare(b.filename));
}