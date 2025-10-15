// src/services/video.service.ts
import { promises as fsPromises } from "fs";
import path from "path";
import { VIDEO_DOWNLOAD_PATH, VIDEO_CONVERT_PATH, VIDEO_MODIFIED_PATH, VIDEO_TRASH_PATH } from "../config.js";
import logger from "../logger.js";
import * as utils from "../utils.js";
import * as types from "../types.js";
import * as errors from "../errors.js";
import * as metadataService from "./metadata.service.js";

const fixingInProgress = new Set<string>();

async function fixPlaylist(videoPath: string, filename: string): Promise<void> {
    if (fixingInProgress.has(filename)) {
        logger.info(`Playlist fixing already in progress for ${filename}, skipping.`);
        return;
    }

    try {
        fixingInProgress.add(filename);
        logger.info(`Starting playlist fix for ${filename}`);

        const tsFiles = (await fsPromises.readdir(videoPath))
            .filter((f) => f.endsWith(".ts"))
            .sort((a, b) => parseInt(a.replace(".ts", ""), 10) - parseInt(b.replace(".ts", ""), 10));

        if (tsFiles.length === 0) {
            return;
        }

        const metadata = await metadataService.cacheMetadata(videoPath, filename, tsFiles);

        const durations = Array.from(metadata.values())
            .map((m) => m.duration)
            .filter((d) => d > 0);
        const targetDuration = durations.length > 0 ? Math.ceil(Math.max(...durations)) : 10;

        const playlistLines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-MEDIA-SEQUENCE:0", `#EXT-X-TARGETDURATION:${targetDuration}`];

        let lastSegmentNumber: number | null = null;
        let lastResolution: string | null = null;

        for (const tsFile of tsFiles) {
            const segmentNumber = parseInt(tsFile.replace(".ts", ""), 10);
            const segmentMeta = metadata.get(tsFile);
            if (!segmentMeta) continue;

            if (lastSegmentNumber === null) {
                // First segment
                playlistLines.push("#EXT-X-DISCONTINUITY");
            } else {
                if (segmentNumber !== lastSegmentNumber + 1 || (lastResolution && segmentMeta.resolution && lastResolution !== segmentMeta.resolution)) {
                    playlistLines.push("#EXT-X-DISCONTINUITY");
                }
            }

            playlistLines.push(`#EXTINF:${segmentMeta.duration.toFixed(3)},`);
            playlistLines.push(tsFile);

            lastSegmentNumber = segmentNumber;
            lastResolution = segmentMeta.resolution;
        }

        playlistLines.push("#EXT-X-ENDLIST");

        const playlistPath = path.join(videoPath, "playlist.m3u8");
        await fsPromises.writeFile(playlistPath, playlistLines.join("\n"), "utf-8");
        logger.info(`Fixed playlist for ${filename}`);
    } catch (error) {
        logger.error(`Failed to fix playlist for ${filename}`, { error });
    } finally {
        fixingInProgress.delete(filename);
    }
}

async function getVideosFromDir(dirPath: string, type: "original" | "edited"): Promise<types.VideoItem[]> {
    const videoItems: types.VideoItem[] = [];
    try {
        await fsPromises.mkdir(dirPath, { recursive: true });
        const entries = await fsPromises.readdir(dirPath, { withFileTypes: true, recursive: false });

        await Promise.all(
            entries.map(async (entry) => {
                if (entry.isDirectory()) {
                    const videoFolderPath = path.join(dirPath, entry.name);
                    try {
                        const tsFiles = (await fsPromises.readdir(videoFolderPath)).filter((f) => f.endsWith(".ts"));
                        if (tsFiles.length > 0) {
                            fixPlaylist(videoFolderPath, entry.name).catch((error) => {
                                logger.error(`Background playlist fix failed for ${entry.name}`, { error });
                            });
                            videoItems.push({ filename: entry.name, type, size: 0, duration: 0 });
                        }
                    } catch (error) {
                        logger.warn(`Could not process directory ${entry.name}, skipping.`, { error });
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

export async function moveVideo(filename: string, destination: "trash" | "original" | "convert", sourcePath?: string): Promise<void> {
    let newPath: string;
    if (destination === "trash") {
        newPath = VIDEO_TRASH_PATH;
    } else if (destination === "original") {
        newPath = VIDEO_DOWNLOAD_PATH;
    } else if (destination === "convert") {
        newPath = VIDEO_CONVERT_PATH;
    } else {
        throw new errors.MoveError("Destination can only be trash, original, or convert.");
    }

    const videoPath = sourcePath ?? (await utils.findVideoPath(filename));
    if (!videoPath) throw new errors.FileNotFoundError(`Video folder not found: ${filename}`);

    if (!videoPath.startsWith(newPath)) {
        let destinationFilename = filename;
        let destinationPath = path.join(newPath, destinationFilename);
        let counter = 1;

        while (true) {
            try {
                await fsPromises.access(destinationPath);
                // Path exists, so we need to find a new name
                destinationFilename = `${filename} (${counter++})`;
                destinationPath = path.join(newPath, destinationFilename);
            } catch (error) {
                // Path does not exist, we've found a unique name.
                break;
            }
        }

        await fsPromises.rename(videoPath, destinationPath);
        logger.info(`Moved folder from ${videoPath} to: ${destinationPath}`);
    } else {
        throw new errors.MoveError("File is already at the destination.");
    }
}
