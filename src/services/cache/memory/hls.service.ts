import { promises as fsPromises } from "fs";
import path from "path";
import logger from "../../../core/logger.js";
import * as utils from "../../../core/utils.js";
import { FILE_NAMES, HLS, MISC } from "../../../core/constants.js";
import * as errors from "../../../core/errors.js";

interface HlsCacheEntry {
    content: string;
    isLive: boolean;
}

const hlsPlaylistCache = new Map<string, HlsCacheEntry>();

export async function updatePlaylistCache(filename: string, videoPath: string): Promise<void> {
    try {
        const playlistPath = path.join(videoPath, FILE_NAMES.HLS_PLAYLIST);
        const content = await fsPromises.readFile(playlistPath, MISC.ENCODING_UTF8);
        const isLive = !content.trim().endsWith(HLS.ENDLIST);
        hlsPlaylistCache.set(filename, { content, isLive });
    } catch (error: any) {
        if (error.code !== MISC.ERROR_CODE.ENOENT) {
            logger.error(`Failed to update HLS playlist cache for ${filename}`, { error });
        }
        hlsPlaylistCache.delete(filename);
    }
}

export function removePlaylistFromCache(filename: string): void {
    if (hlsPlaylistCache.has(filename)) {
        hlsPlaylistCache.delete(filename);
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
            if (error.name !== errors.FileNotFoundError.name) {
                logger.warn(`Could not update playlist cache for live video ${filename}`, { error });
            }
        }
    });

    await Promise.all(updatePromises);
}

export function initializeHlsCache(): void {
    setInterval(updateLivePlaylists, 500);
}
