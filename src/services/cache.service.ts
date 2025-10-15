// src/services/cache.service.ts
import { promises as fsPromises } from "fs";
import path from "path";
import { ALL_VIDEO_PATHS, LIVE_STATUS_PATH } from "../config.js";
import logger from "../logger.js";
import * as types from "../types.js";
import * as metadataService from "./metadata.service.js";
import * as databaseService from "./database.service.js";

const videoCache = new Map<string, types.VideoItem>();
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
        logger.info(`Fixed playlist for ${filename}`);
    } catch (error) {
        logger.error(`Failed to fix playlist for ${filename}`, { error });
    }
}

async function startPlaylistFixerWorker() {
    if (isFixerRunning) return;
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
            if (databaseService.isPlaylistFixed(folder.name)) continue;
            try {
                const files = await fsPromises.readdir(folder.fullPath);
                if (files.some((f) => f.endsWith(".ts"))) {
                    await fixAndCachePlaylist(folder.fullPath, folder.name);
                } else {
                    await databaseService.addFixedPlaylistEntry(folder.name);
                }
            } catch (error) {
                logger.error(`Error processing folder ${folder.name} in fixer worker`, { error });
            }
        }
    } catch (error) {
        logger.error("Playlist fixer worker encountered a critical error.", { error });
    } finally {
        isFixerRunning = false;
        logger.info("Background playlist fixer worker finished.");
    }
}

async function updateVideoCache() {
    logger.info("Updating in-memory video cache...");
    const newCache = new Map<string, types.VideoItem>();
    const liveFolders = await getLiveFolders();

    const allVideoDirs: { path: string; type: "original" | "edited" }[] = [];
    for (const dir of ALL_VIDEO_PATHS) {
        try {
            const entries = await fsPromises.readdir(dir.path, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    allVideoDirs.push({ path: entry.name, type: dir.type });
                }
            }
        } catch (error) {
            logger.error(`Could not read directory for cache update: ${dir.path}`, { error });
        }
    }

    const uniqueVideos = Array.from(new Map(allVideoDirs.map((v) => [v.path, v])).values());

    const cacheUpdatePromises = uniqueVideos.map(async (videoDir) => {
        const filename = videoDir.path;
        const isLive = liveFolders.has(filename);
        if (databaseService.isPlaylistFixed(filename)) {
            const duration = await metadataService.getVideoDuration(filename);
            const videoItem: types.VideoItem = {
                filename,
                type: videoDir.type,
                size: 0,
                duration,
                isLive,
            };
            newCache.set(filename, videoItem);
        } else {
            const videoItem: types.VideoItem = {
                filename,
                type: videoDir.type,
                size: 0,
                duration: 0,
                isLive,
            };
            newCache.set(filename, videoItem);
        }
    });

    await Promise.all(cacheUpdatePromises);
    videoCache.clear();
    for (const [key, value] of newCache.entries()) {
        videoCache.set(key, value);
    }
    logger.info(`In-memory video cache updated with ${videoCache.size} items.`);
    startPlaylistFixerWorker().catch((err) => logger.error("Unhandled error in playlist fixer trigger", { err }));
}

export function initializeCache(): void {
    logger.info("Initializing video cache service...");
    updateVideoCache().catch((err) => logger.error("Initial cache population failed.", { err }));
    setInterval(updateVideoCache, 30000);
}

export function getVideosFromCache(): types.VideoItem[] {
    return Array.from(videoCache.values()).sort((a, b) => a.filename.localeCompare(b.filename));
}

export async function triggerCacheUpdate(): Promise<void> {
    await updateVideoCache();
}
