import { promises as fsPromises } from "fs";
import path from "path";
import * as types from "../../core/types.js";
import * as config from "../../core/config.js";
import * as constants from "../../core/constants.js";
import { getVideoDuration } from "./mp4-edit.service.js";
import logger from "../../core/logger.js";

async function getMp4FilesFromDir(dirPath: string, type: types.VideoType): Promise<types.VideoItem[]> {
    try {
        await fsPromises.mkdir(dirPath, { recursive: true });
        const files = await fsPromises.readdir(dirPath);
        const mp4Files = files.filter((file) => path.extname(file).toLowerCase() === ".mp4");

        const videoDetails = await Promise.all(
            mp4Files.map(async (filename) => {
                const fullPath = path.join(dirPath, filename);
                try {
                    const stats = await fsPromises.stat(fullPath);
                    const duration = await getVideoDuration(fullPath);
                    return { filename, type, size: stats.size, duration, isLive: false };
                } catch (error) {
                    logger.warn(`Could not get stats for MP4 file: ${fullPath}`, { error });
                    return { filename, type, size: 0, duration: 0, isLive: false };
                }
            })
        );
        return videoDetails;
    } catch (error) {
        logger.error(`Could not read directory: ${dirPath}`, { error });
        return [];
    }
}

export async function getAllMp4Videos(provider: string, after?: string): Promise<types.VideoItem[]> {
    const paths = config.getProviderPaths(provider);

    const allFilesPromises = [
        getMp4FilesFromDir(paths.downloader, constants.ALL_VIDEO_PATHS_TYPES.ORIGINAL),
        getMp4FilesFromDir(paths.edited, constants.ALL_VIDEO_PATHS_TYPES.EDITED),
        getMp4FilesFromDir(paths.converted, constants.ALL_VIDEO_PATHS_TYPES.EDITED),
    ];

    const fileArrays = await Promise.all(allFilesPromises);
    let videos = fileArrays.flat();

    if (after) {
        videos = videos.filter((v) => v.filename > after);
    }

    videos.sort((a, b) => a.filename.localeCompare(b.filename));
    return videos;
}
