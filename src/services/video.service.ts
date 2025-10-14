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

export async function getVideosDetails(videos: types.VideoItem[]): Promise<types.VideoItem[]> {
    const detailPromises = videos.map(async (video) => {
        try {
            const videoPath = await utils.findVideoPath(video.filename);
            if (!videoPath) return null;

            //TODO: the video-cacher calculates and caches every detail except for live. for live we always calculate on the fly.
            // to cache: each segment resolution
            // to cache: each segment length - delete all those with length lower than 0.5s
            const duration = 0;
            const size = 0;
            return {
                filename: video.filename,
                type: video.type,
                size,
                duration,
            };
        } catch (error) {
            logger.warn(`Could not get details for ${video.filename}`, { error });
            return null;
        }
    });
    const results = await Promise.all(detailPromises);
    return results.filter((result): result is types.VideoItem => result !== null);
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

export async function createEditedVideo(filename: string, segments: string[]): Promise<void> {
    const videoPath = await utils.findVideoPath(filename);
    if (!videoPath) throw new errors.FileNotFoundError(`Video folder not found: ${filename}`);
    const allSourceTsFiles = (await fsPromises.readdir(videoPath)).filter((f) => f.endsWith(".ts"));
    const segmentSet = new Set(segments);
    const goodTsFiles: Set<string> = new Set();
    for (const tsFile of allSourceTsFiles) {
        if (segmentSet.has(tsFile)) {
            goodTsFiles.add(tsFile);
        }
    }

    if (goodTsFiles.size > 0) {
        const sortedGoodTs = Array.from(goodTsFiles).sort((a, b) => parseInt(a.split(".ts")[0]) - parseInt(b.split(".ts")[0]));
        const parts: string[][] = await getParts(filename, sortedGoodTs); // the duration has been cached by video-cacher, we use that to split

        for (let i = 0; i < parts.length; i++) {
            const tsChunk = parts[i];
            const partFolderName = parts.length > 1 ? `${filename} part${i + 1}` : filename;
            const destinationPath = path.join(VIDEO_CONVERT_PATH, partFolderName);
            await fsPromises.mkdir(destinationPath, { recursive: true });
            const movePromises = tsChunk.map((file) => fsPromises.rename(path.join(filename, file), path.join(destinationPath, file)));
            await Promise.all(movePromises);
            await modifyPlaylist(filename, tsChunk, destinationPath);
            logger.info(`Created part ${i + 1} for ${filename} with ${tsChunk.length} segments at ${destinationPath}`);
        }
    }

    await moveVideo(filename, "trash");
    logger.info(`Successfully processed and removed original folder: ${filename}`);
}

async function getParts(filename: string, tsFiles: string[]) {
    const durations: Map<string, number> = await getDurations(filename);
    let totalDuration = 0;
    const parts: string[][] = [];
    let tsChunk: string[] = [];
    for (const tsFile of tsFiles) {
        let tsDuration;
        if (durations.has(tsFile)) {
            tsDuration = durations.get(tsFile);
        } else {
            tsDuration = await getDuration(path.join(filename, tsFile));
        }
        tsChunk.push(tsFile);
        totalDuration += tsDuration!; // TODO: remove !. why does typescript not pickup durations.has(tsFile)
        if (totalDuration > 30 * 60) {
            parts.push(Array.from(tsChunk)) // TODO: there should be a better way than this hack
            tsChunk = [];
            totalDuration = 0;
        }
    }
    return parts;
}

async function getDurations(folderName: string) {
    // get the duration of each tsFile from cache
    // read file... parse file + create data structure... seen this one before -> should refactor
    const durations = new Map<string, number>();
    return durations;
}

async function getDuration(tsFilename: string) {
    // get the duration of a tsFile from cache
    // we get here only if the tsFile is not already cached... should not happen
    // read file... parse file + create data structure... seen this one before -> should refactor
    const duration = 0;
    return duration;
}

async function modifyPlaylist(filename: string, tsChunk: string[], destinationPath: string) {
    // copies the original playlist in memory, modifies it to add discontinuations, then places it at the destination
    // read file... parse file + create data structure... seen this one before -> should refactor

    // copying things is not a good habbit
    const videoPath = await utils.findVideoPath(filename); 
    const playlistPath = path.join(videoPath, "playlist.m3u8");
    const playlistContent = await fsPromises.readFile(playlistPath, "utf-8");
    
    const lines = playlistContent.split('\n')
    const tsFiles = new Set(tsChunk);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // we do some wizardry and modify the playlist like a surgeon

        // we remove the 
    }
}
