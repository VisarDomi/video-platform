import { promises as fs } from "fs";
import path from "path";
import logger from "../../../logger.js";
import * as cacheService from "./cache.service.js";

const MAX_CACHED_FILENAMES = 3;
const segmentCache = new Map<string, Map<string, Buffer>>();
const cachedFilenames: string[] = [];

async function updateCacheForFilename(filename: string): Promise<void> {
    const videoPath = cacheService.getVideoPathFromCache(filename);
    if (!videoPath) {
        logger.warn(`Cannot cache segments for ${filename}: video path not found.`);
        const index = cachedFilenames.indexOf(filename);
        if (index > -1) {
            cachedFilenames.splice(index, 1);
        }
        return;
    }

    logger.info(`Caching all segments for ${filename}...`);
    try {
        const files = await fs.readdir(videoPath);
        const tsFiles = files.filter((f) => f.endsWith(".ts"));

        const videoSegmentCache = new Map<string, Buffer>();
        segmentCache.set(filename, videoSegmentCache);

        const promises = tsFiles.map(async (tsFile) => {
            const segmentPath = path.join(videoPath, tsFile);
            const content = await fs.readFile(segmentPath);
            videoSegmentCache.set(tsFile, content);
        });

        await Promise.all(promises);
        const totalCachedSegments = Array.from(segmentCache.values()).reduce((sum, map) => sum + map.size, 0);
        logger.info(`Cached ${tsFiles.length} segments for ${filename}. Total cached segments: ${totalCachedSegments}.`);
    } catch (error) {
        logger.error(`Failed to cache segments for ${filename}`, { error });
        // Clean up if caching fails
        segmentCache.delete(filename);
        const index = cachedFilenames.indexOf(filename);
        if (index > -1) {
            cachedFilenames.splice(index, 1);
        }
    }
}

export function getSegment(filename: string, segmentName: string): Buffer | undefined {
    const videoSegmentCache = segmentCache.get(filename);
    if (videoSegmentCache) {
        const segment = videoSegmentCache.get(segmentName);
        if (segment) {
            return segment;
        }
    }

    if (!cachedFilenames.includes(filename)) {
        if (cachedFilenames.length >= MAX_CACHED_FILENAMES) {
            const oldestFilename = cachedFilenames.shift();
            if (oldestFilename) {
                const removedCount = segmentCache.get(oldestFilename)?.size || 0;
                segmentCache.delete(oldestFilename);
                logger.info(`Max cache size reached. Removed ${removedCount} segments for ${oldestFilename}.`);
            }
        }
        cachedFilenames.push(filename);

        updateCacheForFilename(filename).catch((err) => {
            logger.error(`Error during background segment cache update for ${filename}`, { error: err });
        });
    }

    return undefined;
}
