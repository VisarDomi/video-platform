// src/services/video.service.ts
import { promises as fsPromises } from "fs";
import path from "path";
import { VIDEO_DOWNLOAD_PATH, VIDEO_CONVERT_PATH, VIDEO_MODIFIED_PATH } from "../config.js";
import logger from "../logger.js";

type VideoItem = {
    filename: string;
    type: "original" | "edited";
    size: number;
};

async function getVideosFromDir(dirPath: string, type: "original" | "edited"): Promise<VideoItem[]> {
    const videoItems: VideoItem[] = [];
    try {
        await fsPromises.mkdir(dirPath, { recursive: true });
        const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.isDirectory()) {
                const videoFolderPath = path.join(dirPath, entry.name);
                try {
                    const files = await fsPromises.readdir(videoFolderPath);
                    if (files.some((f) => f.endsWith(".ts"))) {
                        videoItems.push({ filename: entry.name, type, size: 0 });
                    }
                } catch (err) {
                    logger.warn(`Could not read subdirectory ${videoFolderPath}`, { err });
                }
            }
        }
    } catch (error) {
        logger.error(`Could not read directory: ${dirPath}`, { error });
    }
    return videoItems;
}

export async function getAllVideos(): Promise<VideoItem[]> {
    // WHY: We explicitly scan the three directories and assign the correct type.
    const downloadPromise = getVideosFromDir(VIDEO_DOWNLOAD_PATH, "original");
    const convertPromise = getVideosFromDir(VIDEO_CONVERT_PATH, "edited");
    const modifiedPromise = getVideosFromDir(VIDEO_MODIFIED_PATH, "edited");

    const [downloadVideos, convertVideos, modifiedVideos] = await Promise.all([downloadPromise, convertPromise, modifiedPromise]);

    const allVideos = [...downloadVideos, ...convertVideos, ...modifiedVideos];
    return allVideos.sort((a, b) => a.filename.localeCompare(b.filename));
}

export async function getAllVideoDurations(): Promise<Record<string, number>> {
    const allVideos = await getAllVideos();
    const durations: Record<string, number> = {};

    for (const video of allVideos) {
        let videoFolderPath: string;
        // WHY: Determine the correct base path based on the video's type.
        if (video.type === "original") {
            videoFolderPath = path.join(VIDEO_DOWNLOAD_PATH, video.filename);
        } else {
            // For "edited" type, we must check both convert and modified folders.
            const convertPath = path.join(VIDEO_CONVERT_PATH, video.filename);
            const modifiedPath = path.join(VIDEO_MODIFIED_PATH, video.filename);
            try {
                await fsPromises.access(convertPath);
                videoFolderPath = convertPath;
            } catch {
                videoFolderPath = modifiedPath; // Assume it's in the modified path if not in convert
            }
        }

        try {
            const files = await fsPromises.readdir(videoFolderPath);
            const tsFilesCount = files.filter((f) => f.endsWith(".ts")).length;
            if (tsFilesCount > 0) {
                durations[video.filename] = tsFilesCount;
            }
        } catch (err) {
            logger.warn(`Could not calculate duration for ${video.filename}`, { path: videoFolderPath, err });
        }
    }

    return durations;
}
