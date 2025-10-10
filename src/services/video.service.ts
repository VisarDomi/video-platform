// src/services/video.service.ts
import { promises as fsPromises } from "fs";
import path from "path";
import { VIDEO_DOWNLOAD_PATH, VIDEO_CONVERT_PATH, VIDEO_MODIFIED_PATH } from "../config.js";
import logger from "../logger.js";
import { FileNotFoundError } from "../errors.js";

type VideoItem = {
    filename: string;
    type: "original" | "edited";
    size: number;
};

// --- Internal Helper Functions ---

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

/**
 * Searches configured directories to find the full path of a video folder.
 */
async function findVideoPath(type: "original" | "edited", folderName: string): Promise<{ fullPath: string; baseDir: string } | null> {
    if (type === "original") {
        const fullPath = path.join(VIDEO_DOWNLOAD_PATH, folderName);
        try {
            await fsPromises.access(fullPath);
            return { fullPath, baseDir: VIDEO_DOWNLOAD_PATH };
        } catch {
            /* not found */
        }
    } else {
        // For 'edited', check 'convert' first, then 'modified'.
        const convertPath = path.join(VIDEO_CONVERT_PATH, folderName);
        try {
            await fsPromises.access(convertPath);
            return { fullPath: convertPath, baseDir: VIDEO_CONVERT_PATH };
        } catch {
            /* not in convert */
        }

        const modifiedPath = path.join(VIDEO_MODIFIED_PATH, folderName);
        try {
            await fsPromises.access(modifiedPath);
            return { fullPath: modifiedPath, baseDir: VIDEO_MODIFIED_PATH };
        } catch {
            /* not in modified */
        }
    }
    return null;
}

// --- Exported Service Functions ---

export async function getAllVideos(): Promise<VideoItem[]> {
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
        if (video.type === "original") {
            videoFolderPath = path.join(VIDEO_DOWNLOAD_PATH, video.filename);
        } else {
            const convertPath = path.join(VIDEO_CONVERT_PATH, video.filename);
            const modifiedPath = path.join(VIDEO_MODIFIED_PATH, video.filename);
            try {
                await fsPromises.access(convertPath);
                videoFolderPath = convertPath;
            } catch {
                videoFolderPath = modifiedPath;
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

export async function trashVideo(type: "original" | "edited", folderName: string): Promise<void> {
    const foundVideo = await findVideoPath(type, folderName);
    if (!foundVideo) {
        throw new FileNotFoundError(`Video folder not found: ${folderName}`);
    }

    // Create a 'trash' subdirectory inside the video's current parent directory (e.g., download/trash)
    const trashDir = path.join(foundVideo.baseDir, "trash");
    await fsPromises.mkdir(trashDir, { recursive: true });

    const destinationPath = path.join(trashDir, folderName);
    await fsPromises.rename(foundVideo.fullPath, destinationPath);
    logger.info(`Moved folder to trash: ${destinationPath}`);
}

export async function moveVideoToEdited(type: "original", folderName: string): Promise<void> {
    if (type !== "original") {
        throw new Error("Only original videos can be moved.");
    }
    const foundVideo = await findVideoPath(type, folderName);
    if (!foundVideo) {
        throw new FileNotFoundError(`Original video folder not found: ${folderName}`);
    }

    const destinationPath = path.join(VIDEO_MODIFIED_PATH, folderName);
    await fsPromises.mkdir(VIDEO_MODIFIED_PATH, { recursive: true });
    await fsPromises.rename(foundVideo.fullPath, destinationPath);
    logger.info(`Moved video to modified folder: ${destinationPath}`);
}

export function createEditedVideo(filename: string, segments: { start: number; end: number }[]): void {
    logger.warn(`Received edit request for ${filename}, but HLS editing is not yet implemented.`, { segments });
    // This is where you would add the job to a queue for background processing with ffmpeg.
}
