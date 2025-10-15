// src/services/hls.service.ts
import { promises as fsPromises } from "fs";
import path from "path";
import logger from "../logger.js";

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
    } catch (error) {
        logger.error(`Failed to update HLS playlist cache for ${filename}`, { error });
        // If we can't read it, remove it to avoid serving stale data
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
