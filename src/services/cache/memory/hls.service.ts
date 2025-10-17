import { promises as fsPromises } from "fs";
import path from "path";
import logger from "../../../logger.js";
import * as utils from "../../../utils.js";

interface HlsCacheEntry {
    content: string;
    isLive: boolean;
}

const hlsPlaylistCache = new Map<string, HlsCacheEntry>();

export async function updatePlaylistCache(filename: string, videoPath: string): Promise<void> {
    try {
        const playlistPath = path.join(videoPath, "playlist.m3u8");
        const content = await fsPromises.readFile(playlistPath, "utf-8");
        const isLive = !content.trim().endsWith("#EXT-X-ENDLIST");
        hlsPlaylistCache.set(filename, { content, isLive });
    } catch (error: any) {
        if (error.code !== "ENOENT") {
            logger.error(`Failed to update HLS playlist cache for ${filename}`, { error });
        }
        hlsPlaylistCache.delete(filename);
    }
}

export function removePlaylistFromCache(filename: string): void {
    if (hlsPlaylistCache.has(filename)) {
        hlsPlaylistCache.delete(filename);
        logger.info(`Removed HLS playlist for ${filename} from cache.`);
    }
}

export function getPlaylistFromCache(filename: string): HlsCacheEntry | undefined {
    return hlsPlaylistCache.get(filename);
}

async function updateLivePlaylists() {
    const liveFolders = await utils.getLiveFolders();
    if (liveFolders.size === 0) return;

    const updatePromises = Array.from(liveFolders).map(async (filename) => {
        try {
            const videoPath = await utils.findVideoPath(filename);
            await updatePlaylistCache(filename, videoPath);
        } catch (error: any) {
            if (error.name !== "FileNotFoundError") {
                logger.warn(`Could not update playlist cache for live video ${filename}`, { error });
            }
        }
    });

    await Promise.all(updatePromises);
}

export function initializeHlsCache(): void {
    logger.info("Initializing HLS playlist cache service...");
    setInterval(updateLivePlaylists, 500);
}
