// src/services/video.service.ts
import { promises as fsPromises } from "fs";
import path from "path";
import { VIDEO_ROOT_DIRS } from "../config.js";
import { findVideoPath } from "../utils.js";
import logger from "../logger.js";
import { FileNotFoundError } from "../errors.js";
import * as ffmpeg from "./ffmpeg.service.js";
import { JobQueue } from "./queue.service.js";

/**
 * @fileoverview
 * This service acts as a facade for all video-related operations.
 * It coordinates file system tasks, video metadata retrieval (via ffmpeg.service),
 * and video processing jobs (via queue.service).
 */

type EditJob = {
    filename: string;
    segments: { start: number; end: number }[];
};

// --- Internal Helper Functions ---

/**
 * Moves a file to a 'trash' subdirectory within its base directory.
 */
async function moveFileToTrash(filePath: string, baseDir: string) {
    const trashDir = path.join(baseDir, "trash");
    await fsPromises.mkdir(trashDir, { recursive: true });

    const filename = path.basename(filePath);
    const destinationPath = path.join(trashDir, filename);

    await fsPromises.rename(filePath, destinationPath);
    logger.info(`Moved file to trash: ${destinationPath}`);
}

/**
 * Reads a directory and returns a list of video file objects, including file size.
 */
async function getVideosFromDir(dirPath: string, type: "original" | "edited") {
    try {
        await fsPromises.mkdir(dirPath, { recursive: true });
        const files = await fsPromises.readdir(dirPath);
        const mp4Files = files.filter((file) => path.extname(file).toLowerCase() === ".mp4");

        const videoDetails = await Promise.all(
            mp4Files.map(async (filename) => {
                const fullPath = path.join(dirPath, filename);
                try {
                    const stats = await fsPromises.stat(fullPath);
                    // Return the full object including the size from stats
                    return { filename, type, size: stats.size };
                } catch (statError) {
                    logger.warn(`Could not get stats for file: ${fullPath}`, { statError });
                    // Return with size 0 if stats fail for any reason
                    return { filename, type, size: 0 };
                }
            })
        );
        return videoDetails;
    } catch (error) {
        logger.error(`Could not read directory: ${dirPath}`, { error });
        return []; // Return empty array on error
    }
}

/**
 * The core logic for processing a single video edit job. This function is passed
 * to our job queue to be executed for each item.
 *
 * It now follows the "Safe Temp File" pattern:
 * 1. FFMPEG writes to a unique temporary file.
 * 2. If successful, the temp file is atomically renamed to the final destination.
 * 3. If it fails, the temp file is cleaned up.
 */
async function _processVideoEdit(job: EditJob) {
    const { filename, segments } = job;
    const foundVideo = await findVideoPath("original", filename);
    if (!foundVideo) {
        throw new FileNotFoundError(`Original video file not found: ${filename}`);
    }

    const { fullPath: sourcePath, baseDir } = foundVideo;
    const editedVideosDir = path.join(baseDir, "edited");

    // 1. Define final path and a unique temporary path
    const finalOutputPath = path.join(editedVideosDir, filename);
    const tempOutputPath = `${finalOutputPath}.${Date.now()}.tmp`;

    await fsPromises.mkdir(editedVideosDir, { recursive: true });

    try {
        logger.info(`Processing job for: ${filename} -> ${tempOutputPath}`, { segments });

        // 2. FFMPEG now writes to the temporary file
        const ffmpegArgs = ffmpeg.buildFfmpegArgs(sourcePath, tempOutputPath, segments);
        await ffmpeg.executeFfmpegCommand(ffmpegArgs);

        // 3. On success, perform the SAFE and INSTANT rename
        await fsPromises.rename(tempOutputPath, finalOutputPath);
        logger.info(`Successfully created edited video: ${finalOutputPath}`);

        // 4. Auto-move original file to trash on success
        await moveFileToTrash(sourcePath, baseDir);
    } catch (error) {
        logger.error(`Processing failed for ${filename}. Cleaning up temporary file.`, { job, error });
        // 5. IMPORTANT: Clean up the failed temp file
        try {
            await fsPromises.unlink(tempOutputPath);
        } catch (cleanupError) {
            // Log a warning if cleanup fails, but don't crash the whole worker
            logger.warn(`Could not clean up temporary file: ${tempOutputPath}`, { cleanupError });
        }
        // Re-throw the original error so the job queue knows the job failed
        throw error;
    }
}

// --- Initialize the Video Editing Queue ---
// We create a single instance of the queue and pass it our processing function.
const editQueue = new JobQueue<EditJob>(_processVideoEdit);

// --- Exported Service Functions ---

export async function getAllVideos() {
    const allFilesPromises = VIDEO_ROOT_DIRS.flatMap((dir) => [getVideosFromDir(dir, "original"), getVideosFromDir(path.join(dir, "edited"), "edited")]);

    const fileArrays = await Promise.all(allFilesPromises);
    return fileArrays.flat().sort((a, b) => a.filename.localeCompare(b.filename));
}

export async function trashVideo(type: "original" | "edited", filename: string) {
    const foundVideo = await findVideoPath(type, filename);
    if (!foundVideo) {
        throw new FileNotFoundError(`Video file not found: ${filename}`);
    }
    await moveFileToTrash(foundVideo.fullPath, foundVideo.baseDir);
}

/**
 * Adds a video editing job to the background queue.
 * This is now a simple one-liner that delegates to the queue service.
 */
export function createEditedVideo(filename: string, segments: { start: number; end: number }[]) {
    editQueue.add({ filename, segments });
}

export async function moveVideoToEdited(type: "original", filename: string) {
    if (type !== "original") {
        throw new Error("Only original videos can be moved to the edited folder.");
    }

    const foundVideo = await findVideoPath(type, filename);
    if (!foundVideo) {
        throw new FileNotFoundError(`Video file not found: ${filename}`);
    }

    const { fullPath: sourcePath, baseDir } = foundVideo;
    const editedVideosDir = path.join(baseDir, "edited");
    const destinationPath = path.join(editedVideosDir, filename);

    await fsPromises.mkdir(editedVideosDir, { recursive: true });
    await fsPromises.rename(sourcePath, destinationPath);
    logger.info(`Moved video to edited folder: ${destinationPath}`);
}

/**
 * Gets durations for all video files by calling the ffmpeg service.
 */
export async function getAllVideoDurations(): Promise<Record<string, number>> {
    const allVideos = await getAllVideos();
    const durationPromises = allVideos.map(async (video) => {
        const foundVideo = await findVideoPath(video.type, video.filename);
        if (!foundVideo) {
            return { filename: video.filename, duration: 0 };
        }
        // Delegate the complex part to the ffmpeg service
        const duration = await ffmpeg.getVideoDuration(foundVideo.fullPath);
        return { filename: video.filename, duration };
    });

    const results = await Promise.all(durationPromises);

    // Convert array of objects to a single { filename: duration } object
    return results.reduce((acc, { filename, duration }) => {
        acc[filename] = duration;
        return acc;
    }, {} as Record<string, number>);
}
