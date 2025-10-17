import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import pLimit from "p-limit";
import logger from "../../../logger.js";
import * as databaseService from "./database.service.js";

const execFileAsync = promisify(execFile);
const limit = pLimit(10);

export interface SegmentMetadata {
    duration: number;
    resolution: string | null;
}

async function getSegmentMetadata(tsFilePath: string): Promise<SegmentMetadata> {
    try {
        const { stdout } = await execFileAsync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", tsFilePath]);
        const data = JSON.parse(stdout);
        const duration = parseFloat(data.format.duration);
        const videoStream = data.streams.find((s: any) => s.codec_type === "video");
        const resolution = videoStream ? `${videoStream.width}x${videoStream.height}` : null;

        if (isNaN(duration)) {
            logger.error(`ffprobe output for ${tsFilePath} has invalid duration: ${data.format.duration}`);
            return { duration: 0, resolution };
        }
        return { duration, resolution };
    } catch (error) {
        logger.error(`Failed to get metadata for ${tsFilePath} using ffprobe.`, { error });
        return { duration: 0, resolution: null };
    }
}

async function getMetadata(filename: string): Promise<Map<string, SegmentMetadata>> {
    return new Promise((resolve, reject) => {
        const sql = `SELECT ts_filename, duration, resolution FROM durations WHERE video_filename = ?`;
        databaseService.db.all(sql, [filename], (err, rows: { ts_filename: string; duration: number; resolution: string | null }[]) => {
            if (err) {
                logger.error(`Failed to get metadata for ${filename} from database.`, { error: err });
                return reject(err);
            }
            const metadata = new Map<string, SegmentMetadata>();
            rows.forEach((row) => {
                metadata.set(row.ts_filename, { duration: row.duration, resolution: row.resolution });
            });
            resolve(metadata);
        });
    });
}

export async function getVideoDuration(filename: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const sql = `SELECT SUM(duration) as totalDuration FROM durations WHERE video_filename = ?`;
        databaseService.db.get(sql, [filename], (err, row: { totalDuration: number | null }) => {
            if (err) {
                logger.error(`Failed to get total duration for ${filename} from database.`, { error: err });
                return reject(err);
            }
            resolve(row?.totalDuration || 0);
        });
    });
}

export async function cacheMetadata(videoPath: string, filename: string, tsFiles: string[]): Promise<Map<string, SegmentMetadata>> {
    const metadata: Map<string, SegmentMetadata> = await getMetadata(filename);
    const cacheMisses = tsFiles.filter((tsFile) => !metadata.has(tsFile) || !metadata.get(tsFile)?.resolution);

    if (cacheMisses.length > 0) {
        const metadataPromises = cacheMisses.map((tsFile) => {
            const fullPath = path.join(videoPath, tsFile);
            return limit(() => getSegmentMetadata(fullPath));
        });
        const newMetadata = await Promise.all(metadataPromises);

        cacheMisses.forEach((tsFile, index) => {
            metadata.set(tsFile, newMetadata[index]);
        });

        const stmt = databaseService.db.prepare("INSERT OR REPLACE INTO durations (video_filename, ts_filename, duration, resolution) VALUES (?, ?, ?, ?)");
        databaseService.db.serialize(() => {
            databaseService.db.run("BEGIN TRANSACTION");
            cacheMisses.forEach((tsFile, index) => {
                const meta = newMetadata[index];
                stmt.run(filename, tsFile, meta.duration, meta.resolution);
            });
            databaseService.db.run("COMMIT", (err) => {
                if (err) {
                    logger.error(`Failed to commit metadata cache for ${filename}.`, { error: err });
                }
            });
        });
        stmt.finalize();
    }
    return metadata;
}
