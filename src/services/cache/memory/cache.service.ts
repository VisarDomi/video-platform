import { promises as fsPromises } from "fs";
import path from "path";
import { ALL_VIDEO_PATHS } from "../../../core/config.js";
import logger from "../../../core/logger.js";
import * as types from "../../../core/types.js";
import * as metadataService from "../disk/metadata.service.js";
import * as databaseService from "../disk/database.service.js";
import * as utils from "../../../core/utils.js";
import * as hlsService from "./hls.service.js";
import { FILE_EXTENSIONS, FILE_NAMES, HLS, MISC } from "../../../core/constants.js";

const videoCache = new Map<string, types.VideoItem>();
const videoPathCache = new Map<string, string>();
let isCacheUpdating = false;
let lastThrottledUpdateTime = 0;
const CACHE_UPDATE_THROTTLE_MS = 10000; // 10 seconds
let isFixerRunning = false;

export async function fixAndCachePlaylist(videoPath: string, filename: string): Promise<void> {
    try {
        const tsFiles = (await fsPromises.readdir(videoPath))
            .filter((f) => f.endsWith(FILE_EXTENSIONS.TS))
            .sort((a, b) => parseInt(a.replace(FILE_EXTENSIONS.TS, ""), 10) - parseInt(b.replace(FILE_EXTENSIONS.TS, ""), 10));

        if (tsFiles.length === 0) {
            await databaseService.addFixedPlaylistEntry(filename);
            return;
        }

        const metadata = await metadataService.cacheMetadata(videoPath, filename, tsFiles);
        const durations = Array.from(metadata.values())
            .map((m) => m.duration)
            .filter((d) => d > 0);
        const targetDuration = durations.length > 0 ? Math.ceil(Math.max(...durations)) : 10;
        const playlistLines = [HLS.HEADER, HLS.VERSION, HLS.MEDIA_SEQUENCE, `${HLS.TARGET_DURATION_PREFIX}${targetDuration}`];

        let lastSegmentNumber: number | null = null;
        let lastResolution: string | null = null;

        for (const tsFile of tsFiles) {
            const segmentNumber = parseInt(tsFile.replace(FILE_EXTENSIONS.TS, ""), 10);
            const segmentMeta = metadata.get(tsFile);
            if (!segmentMeta) continue;

            if (lastSegmentNumber === null) {
                playlistLines.push(HLS.DISCONTINUITY);
            } else {
                if (segmentNumber !== lastSegmentNumber + 1 || (lastResolution && segmentMeta.resolution && lastResolution !== segmentMeta.resolution)) {
                    playlistLines.push(HLS.DISCONTINUITY);
                }
            }

            playlistLines.push(`${HLS.INF_PREFIX}${segmentMeta.duration.toFixed(3)},`);
            playlistLines.push(tsFile);
            lastSegmentNumber = segmentNumber;
            lastResolution = segmentMeta.resolution;
        }
        playlistLines.push(HLS.ENDLIST);
        const playlistPath = path.join(videoPath, FILE_NAMES.HLS_PLAYLIST);
        await fsPromises.writeFile(playlistPath, playlistLines.join("\n"), MISC.ENCODING_UTF8);
        await hlsService.updatePlaylistCache(filename, videoPath);
        await databaseService.addFixedPlaylistEntry(filename);
    } catch (error) {
        logger.error(`Failed to fix playlist for ${filename}`, { error });
    }
}

async function startPlaylistFixerWorker() {
    if (isFixerRunning) return;
    isFixerRunning = true;

    try {
        const liveFolders = await utils.getLiveFolders();
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
                continue;
            }
            if (databaseService.isPlaylistFixed(folder.name)) continue;
            try {
                const files = await fsPromises.readdir(folder.fullPath);
                if (files.some((f) => f.endsWith(FILE_EXTENSIONS.TS))) {
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
    }
}

async function updateVideoCache() {
    if (isCacheUpdating) {
        return;
    }
    isCacheUpdating = true;

    try {
        const newCache = new Map<string, types.VideoItem>();
        const newPathCache = new Map<string, string>();
        const liveFolders = await utils.getLiveFolders();

        const allVideoDirs: { name: string; fullPath: string; type: types.VideoType }[] = [];
        for (const dir of ALL_VIDEO_PATHS) {
            try {
                const entries = await fsPromises.readdir(dir.path, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        allVideoDirs.push({ name: entry.name, fullPath: path.join(dir.path, entry.name), type: dir.type });
                    }
                }
            } catch (error) {
                logger.error(`Could not read directory for cache update: ${dir.path}`, { error });
            }
        }

        const uniqueVideos = Array.from(new Map(allVideoDirs.map((v) => [v.name, v])).values());

        const cacheUpdatePromises = uniqueVideos.map(async (videoDir) => {
            const filename = videoDir.name;
            newPathCache.set(filename, videoDir.fullPath);
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

            if (!isLive) {
                try {
                    await hlsService.updatePlaylistCache(filename, videoDir.fullPath);
                } catch (err: any) {
                    if (err.name !== "FileNotFoundError") {
                        logger.warn(`Could not process playlist for ${filename} during cache update`, { error: err });
                    }
                }
            }
        });

        await Promise.all(cacheUpdatePromises);
        videoCache.clear();
        videoPathCache.clear();
        for (const [key, value] of newCache.entries()) {
            videoCache.set(key, value);
        }
        for (const [key, value] of newPathCache.entries()) {
            videoPathCache.set(key, value);
        }
        startPlaylistFixerWorker().catch((err) => logger.error("Unhandled error in playlist fixer trigger", { err }));
    } finally {
        isCacheUpdating = false;
    }
}

export function initializeCache(): void {
    updateVideoCache().catch((err) => logger.error("Initial cache population failed.", { err }));
    setInterval(updateVideoCache, 30000);
}

export function getVideosFromCache(): types.VideoItem[] {
    return Array.from(videoCache.values()).sort((a, b) => a.filename.localeCompare(b.filename));
}

export function getVideoPathFromCache(filename: string): string | undefined {
    return videoPathCache.get(filename);
}

export async function triggerCacheUpdate(): Promise<void> {
    await updateVideoCache();
}

export function requestThrottledCacheUpdate(): void {
    const now = Date.now();
    if (now - lastThrottledUpdateTime < CACHE_UPDATE_THROTTLE_MS) {
        return;
    }
    lastThrottledUpdateTime = now;
    updateVideoCache().catch((err) => logger.error("Throttled cache update failed", { err }));
}
