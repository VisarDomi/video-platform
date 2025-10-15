// src/services/metadata.service.ts
import { promises as fsPromises } from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import pLimit from "p-limit";
import logger from "../logger.js";
import * as utils from "../utils.js";
import * as types from "../types.js";
import * as databaseService from "./database.service.js";

const execFileAsync = promisify(execFile);
const limit = pLimit(10); // Limit concurrency to 10 ffprobe processes at a time
const cachingInProgress = new Set<string>(); // In-memory lock

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
    return new Promise((resolve, reject) => {
        const sql = `SELECT ts_filename, duration FROM durations WHERE video_filename = ?`;
        databaseService.db.all(sql, [filename], (err, rows: { ts_filename: string; duration: number }[]) => {
            if (err) {
                logger.error(`Failed to get durations for ${filename} from database.`, { error: err });
                return reject(err);
            }
            const durations = new Map<string, number>();
            rows.forEach((row) => {
                durations.set(row.ts_filename, row.duration);
            });
            resolve(durations);
        });
    });
}

export async function cacheDurations(videoPath: string, filename: string, tsFiles: string[]): Promise<Map<string, number>> {
    const durations: Map<string, number> = await getDurations(filename);
    const cacheMisses = tsFiles.filter((tsFile) => !durations.has(tsFile));

    if (cacheMisses.length > 0) {
        const durationPromises = cacheMisses.map((tsFile) => {
            const fullPath = path.join(videoPath, tsFile);
            return limit(() => getDuration(fullPath));
        });
        const newDurations = await Promise.all(durationPromises);

        cacheMisses.forEach((tsFile, index) => {
            durations.set(tsFile, newDurations[index]);
        });

        // Write the updated durations back to the database.
        const stmt = databaseService.db.prepare("INSERT INTO durations (video_filename, ts_filename, duration) VALUES (?, ?, ?)");
        databaseService.db.serialize(() => {
            databaseService.db.run("BEGIN TRANSACTION");
            cacheMisses.forEach((tsFile, index) => {
                stmt.run(filename, tsFile, newDurations[index]);
            });
            databaseService.db.run("COMMIT", (err) => {
                if (err) {
                    logger.error(`Failed to commit duration cache for ${filename}.`, { error: err });
                }
            });
        });
        stmt.finalize();
    }
    return durations;
}

export async function getVideosDetails(videos: types.VideoItem[]): Promise<types.VideoItem[]> {
    const videoDetailsPromises = videos.map(async (video): Promise<types.VideoItem> => {
        try {
            if (cachingInProgress.has(video.filename)) {
                logger.info(`Caching already in progress for ${video.filename}. Skipping duplicate request.`);
                return { ...video, size: 0, duration: 0 };
            }

            const videoPath = await utils.findVideoPath(video.filename);
            const tsFiles = (await fsPromises.readdir(videoPath)).filter((f) => f.endsWith(".ts"));

            const durations = await getDurations(video.filename);
            const cacheMisses = tsFiles.filter((tsFile) => !durations.has(tsFile));

            if (cacheMisses.length > 0) {
                cachingInProgress.add(video.filename);
                cacheDurations(videoPath, video.filename, tsFiles)
                    .catch((error) => {
                        logger.error(`Background duration caching failed for ${video.filename}`, { error });
                    })
                    .finally(() => {
                        cachingInProgress.delete(video.filename);
                    });

                return { ...video, size: 0, duration: 0 };
            } else {
                let totalDuration = 0;
                for (const tsFile of tsFiles) {
                    totalDuration += durations.get(tsFile) || 0;
                }
                return { ...video, size: 0, duration: totalDuration };
            }
        } catch (error) {
            logger.warn(`Could not get details for ${video.filename}, returning duration 0.`, { error });
            return { ...video, size: 0, duration: 0 };
        }
    });

    return Promise.all(videoDetailsPromises);
}
