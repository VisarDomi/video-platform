// src/services/metadata.service.ts
import { promises as fsPromises } from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import pLimit from "p-limit";
import logger from "../logger.js";
import * as utils from "../utils.js";
import * as types from "../types.js";
import * as config from "../config.js";

const execFileAsync = promisify(execFile);
const limit = pLimit(10); // Limit concurrency to 10 ffprobe processes at a time

async function getDuration(tsFilePath: string): Promise<number> {
    try {
        const { stdout } = await execFileAsync("ffprobe", [
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            tsFilePath,
        ]);
        const duration = parseFloat(stdout.trim());
        if (isNaN(duration)) {
            logger.error(`ffprobe output for ${tsFilePath} is not a number: ${stdout}`);
            return 0;
        }
        return duration;
    } catch (error) {
        logger.error(`Failed to get duration for ${tsFilePath} using ffprobe.`, { error });
        return 0;
    }
}

async function getDurations(filename: string): Promise<Map<string, number>> {
    const metadataPath = path.join(config.CACHE_PATH, `${filename}.json`);
    const durations = new Map<string, number>();

    try {
        const fileContent = await fsPromises.readFile(metadataPath, "utf-8");
        const durationData = JSON.parse(fileContent) as Record<string, number>;
        for (const [tsFile, duration] of Object.entries(durationData)) {
            durations.set(tsFile, duration);
        }
    } catch (error: any) {
        if (error?.code === "ENOENT") {
            // This is expected, so no log is needed here as cacheDurations will log it.
        } else {
            logger.warn(`Could not read or parse duration cache for ${filename} from ${metadataPath}. Will proceed without cache.`, { error });
        }
    }

    return durations;
}

export async function cacheDurations(videoPath: string, filename: string, tsFiles: string[]): Promise<Map<string, number>> {
    const durations: Map<string, number> = await getDurations(filename);

    const cacheMisses = tsFiles.filter((tsFile) => !durations.has(tsFile));

    if (cacheMisses.length > 0) {
        logger.info(`Found ${cacheMisses.length} cache misses for video ${filename}. Fetching durations in parallel.`);
        const durationPromises = cacheMisses.map((tsFile) => {
            const fullPath = path.join(videoPath, tsFile);
            return limit(() => getDuration(fullPath));
        });
        const newDurations = await Promise.all(durationPromises);

        cacheMisses.forEach((tsFile, index) => {
            durations.set(tsFile, newDurations[index]);
        });

        // Write the updated durations back to the cache file.
        try {
            const metadataPath = path.join(config.CACHE_PATH, `${filename}.json`);
            const durationData = Object.fromEntries(durations);
            await fsPromises.writeFile(metadataPath, JSON.stringify(durationData, null, 2), "utf-8");
            logger.info(`Successfully updated duration cache for ${filename}.`);
        } catch (error) {
            logger.error(`Failed to write duration cache for ${filename}.`, { error });
            // This is a non-critical error, so we just log it and continue.
        }
    }

    return durations;
}

export async function getVideosDetails(videos: types.VideoItem[]): Promise<types.VideoItem[]> {
    const videoDetailsPromises = videos.map(async (video): Promise<types.VideoItem> => {
        try {
            const videoPath = await utils.findVideoPath(video.filename);
            const tsFiles = (await fsPromises.readdir(videoPath)).filter((f) => f.endsWith(".ts"));

            // Read existing cache without triggering new calculations yet
            const durations = await getDurations(video.filename);

            const cacheMisses = tsFiles.filter((tsFile) => !durations.has(tsFile));

            if (cacheMisses.length > 0) {
                // There are cache misses. Return 0 duration and trigger background caching.
                // Fire-and-forget promise for caching
                cacheDurations(videoPath, video.filename, tsFiles).catch((error) => {
                    logger.error(`Background duration caching failed for ${video.filename}`, { error });
                });

                return {
                    ...video,
                    size: 0, // calculated on the frontend
                    duration: 0,
                };
            } else {
                // All durations are cached. Calculate total duration and return it.
                let totalDuration = 0;
                for (const tsFile of tsFiles) {
                    totalDuration += durations.get(tsFile) || 0;
                }
                return {
                    ...video,
                    size: 0, // calculated on the frontend
                    duration: totalDuration,
                };
            }
        } catch (error) {
            logger.warn(`Could not get details for ${video.filename}, returning duration 0.`, { error });
            // Return with duration 0 on error
            return {
                ...video,
                size: 0,
                duration: 0,
            };
        }
    });

    return Promise.all(videoDetailsPromises);
}
