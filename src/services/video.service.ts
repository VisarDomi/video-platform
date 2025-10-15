// src/services/video.service.ts
import { promises as fsPromises } from "fs";
import path from "path";
import { ALL_VIDEO_PATHS, VIDEO_DOWNLOAD_PATH, VIDEO_CONVERT_PATH, VIDEO_MODIFIED_PATH, VIDEO_TRASH_PATH, LIVE_STATUS_PATH } from "../config.js";
import logger from "../logger.js";
import * as utils from "../utils.js";
import * as types from "../types.js";
import * as errors from "../errors.js";
import * as metadataService from "./metadata.service.js";
import * as databaseService from "./database.service.js";

let isFixerRunning = false;

async function getLiveFolders(): Promise<Set<string>> {
    try {
        const content = await fsPromises.readFile(LIVE_STATUS_PATH, "utf-8");
        const liveData = JSON.parse(content);
        if (Array.isArray(liveData)) {
            return new Set(liveData);
        }
        logger.warn("live-status.json is not an array, ignoring.");
        return new Set();
    } catch (error: any) {
        if (error.code !== "ENOENT") {
            logger.error("Failed to read or parse live-status.json", { error });
        }
        return new Set();
    }
}

async function fixAndCachePlaylist(videoPath: string, filename: string): Promise<void> {
    try {
        logger.info(`Starting playlist fix for ${filename}`);

        const tsFiles = (await fsPromises.readdir(videoPath))
            .filter((f) => f.endsWith(".ts"))
            .sort((a, b) => parseInt(a.replace(".ts", ""), 10) - parseInt(b.replace(".ts", ""), 10));

        if (tsFiles.length === 0) {
            await databaseService.addFixedPlaylistEntry(filename);
            metadataService.updateVideoDetailsCache(filename, 0);
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
        await databaseService.addFixedPlaylistEntry(filename);

        let totalDuration = 0;
        for (const tsFile of tsFiles) {
            totalDuration += metadata.get(tsFile)?.duration || 0;
        }
        metadataService.updateVideoDetailsCache(filename, totalDuration);

        logger.info(`Fixed playlist for ${filename}`);
    } catch (error) {
        logger.error(`Failed to fix playlist for ${filename}`, { error });
    }
}

export async function startPlaylistFixerWorker() {
    if (isFixerRunning) {
        return;
    }
    isFixerRunning = true;
    logger.info("Starting background playlist fixer worker.");

    try {
        const liveFolders = await getLiveFolders();
        let allFolders: { name: string; fullPath: string }[] = [];
        for (const dir of ALL_VIDEO_PATHS) {
            try {
                const entries = await fsPromises.readdir(dir.path, { withFileTypes: true });
                const folders = entries
                    .filter((entry) => entry.isDirectory())
                    .map((entry) => ({ name: entry.name, fullPath: path.join(dir.path, entry.name) }));
                allFolders.push(...folders);
            } catch (error) {
                logger.warn(`Could not read directory for fixer: ${dir.path}`, { error });
            }
        }

        allFolders.sort((a, b) => a.name.localeCompare(b.name));

        for (const folder of allFolders) {
            if (liveFolders.has(folder.name)) {
                logger.info(`Skipping folder ${folder.name} because it is currently live.`);
                continue;
            }

            if (databaseService.isPlaylistFixed(folder.name)) {
                if (!metadataService.isVideoDetailsCached(folder.name)) {
                    try {
                        const tsFiles = (await fsPromises.readdir(folder.fullPath)).filter((f) => f.endsWith(".ts"));
                        if (tsFiles.length === 0) {
                            metadataService.updateVideoDetailsCache(folder.name, 0);
                            continue;
                        }
                        const metadata = await metadataService.getMetadataFromDb(folder.name);
                        let totalDuration = 0;
                        for (const tsFile of tsFiles) {
                            totalDuration += metadata.get(tsFile)?.duration || 0;
                        }
                        metadataService.updateVideoDetailsCache(folder.name, totalDuration);
                    } catch (error) {
                        logger.error(`Error populating memory cache for ${folder.name}`, { error });
                    }
                }
            } else {
                await fixAndCachePlaylist(folder.fullPath, folder.name);
            }
        }
    } catch (error) {
        logger.error("Playlist fixer worker encountered a critical error.", { error });
    } finally {
        isFixerRunning = false;
        logger.info("Background playlist fixer worker finished.");
    }
}

async function getVideosFromDir(dirPath: string, type: "original" | "edited"): Promise<types.VideoItem[]> {
    const videoItems: types.VideoItem[] = [];
    try {
        await fsPromises.mkdir(dirPath, { recursive: true });
        const entries = await fsPromises.readdir(dirPath, { withFileTypes: true, recursive: false });

        for (const entry of entries) {
            if (entry.isDirectory()) {
                const videoFolderPath = path.join(dirPath, entry.name);
                const playlistPath = path.join(videoFolderPath, "playlist.m3u8");
                try {
                    await fsPromises.access(playlistPath);
                    videoItems.push({ filename: entry.name, type, size: 0, duration: 0 });
                } catch (err) {
                    // Skip folders without a playlist, they can't be played by the frontend.
                    // The background worker will handle creating the playlist.
                }
            }
        }
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
                destinationFilename = `${filename} (${counter++})`;
                destinationPath = path.join(newPath, destinationFilename);
            } catch (error) {
                break;
            }
        }

        await fsPromises.rename(videoPath, destinationPath);
        await databaseService.removeFixedPlaylistEntry(filename);
        metadataService.removeVideoDetailsFromCache(filename);
        logger.info(`Moved folder from ${videoPath} to: ${destinationPath} and removed from caches.`);
    } else {
        throw new errors.MoveError("File is already at the destination.");
    }
}
