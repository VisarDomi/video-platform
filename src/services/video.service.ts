// src/services/video.service.ts
import { promises as fsPromises } from "fs";
import path from "path";
import { VIDEO_DOWNLOAD_PATH, VIDEO_CONVERT_PATH, VIDEO_MODIFIED_PATH, VIDEO_TRASH_PATH } from "../config.js";
import logger from "../logger.js";
import * as utils from "../utils.js";
import * as types from "../types.js";
import * as errors from "../errors.js";

async function getVideosFromDir(dirPath: string, type: "original" | "edited"): Promise<types.VideoItem[]> {
    const videoItems: types.VideoItem[] = [];
    try {
        await fsPromises.mkdir(dirPath, { recursive: true });
        const entries = await fsPromises.readdir(dirPath, { withFileTypes: true, recursive: false });

        await Promise.all(
            entries.map(async (entry) => {
                if (entry.isDirectory()) {
                    const videoFolderPath = path.join(dirPath, entry.name);
                    const playlistPath = path.join(videoFolderPath, "playlist.m3u8");
                    try {
                        await fsPromises.access(playlistPath);
                        videoItems.push({ filename: entry.name, type, size: 0, duration: 0 });
                    } catch (err) {
                        // Skip folders without a playlist, they can't be played by the frontend's hls.js
                    }
                }
            })
        );
    } catch (error) {
        logger.error(`Could not read directory: ${dirPath}`, { error });
    }
    return videoItems;
}

export async function getAllVideos(): Promise<types.VideoItem[]> {
    const downloadPromise = getVideosFromDir(VIDEO_DOWNLOAD_PATH, "original");
    const convertPromise = getVideosFromDir(VIDEO_CONVERT_PATH, "edited");
    const modifiedPromise = getVideosFromDir(VIDEO_MODIFIED_PATH, "edited");
    const [downloadVideos, convertVideos, modifiedVideos] = await Promise.all([downloadPromise, convertPromise, modifiedPromise]);
    return [...downloadVideos, ...convertVideos, ...modifiedVideos].sort((a, b) => a.filename.localeCompare(b.filename));
}

export async function moveVideo(filename: string, destination: "trash" | "original"): Promise<void> {
    let newPath: string;
    if (destination !== "trash" && destination !== "original") {
        throw new errors.MoveError("destination can only have the values trash or original");
    } else {
        if (destination === "trash") {
            newPath = VIDEO_TRASH_PATH;
        } else {
            newPath = VIDEO_DOWNLOAD_PATH;
        }
    }
    const videoPath = await utils.findVideoPath(filename);
    if (!videoPath) throw new errors.FileNotFoundError(`Video folder not found: ${filename}`);
    if (!videoPath.includes(newPath)) {
        const destinationPath = path.join(newPath, filename);
        await fsPromises.rename(videoPath, destinationPath);
        logger.info(`Moved folder to: ${destinationPath}`);
    } else {
        throw new errors.MoveError("File is already at the destination.");
    }
}
