import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import pLimit from "p-limit";
import logger from "../../../core/logger.js";
import * as databaseService from "./database.service.js";
import { DATABASE, FFMPEG } from "../../../core/constants.js";

const execFileAsync = promisify(execFile);
const limit = pLimit(10);

export interface SegmentMetadata {
    duration: number;
    resolution: string | null;
}

async function getSegmentMetadata(tsFilePath: string): Promise<SegmentMetadata> {
    try {
        const { stdout } = await execFileAsync(FFMPEG.COMMAND, [
            FFMPEG.ARGS.QUIET,
            FFMPEG.ARGS.QUIET_LEVEL,
            FFMPEG.ARGS.PRINT_FORMAT,
            FFMPEG.ARGS.FORMAT_JSON,
            FFMPEG.ARGS.SHOW_FORMAT,
            FFMPEG.ARGS.SHOW_STREAMS,
            tsFilePath,
        ]);
        const data = JSON.parse(stdout);
        const duration = parseFloat(data.format.duration);
        const videoStream = data.streams.find((s: any) => s.codec_type === FFMPEG.CODEC_TYPE_VIDEO);
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
        const sql = `SELECT ${DATABASE.COLUMNS.TS_FILENAME}, ${DATABASE.COLUMNS.DURATION}, ${DATABASE.COLUMNS.RESOLUTION} FROM ${DATABASE.TABLES.DURATIONS} WHERE ${DATABASE.COLUMNS.VIDEO_FILENAME} = ?`;
        databaseService.db.all(
            sql,
            [filename],
            (
                err,
                rows: {
                    [DATABASE.COLUMNS.TS_FILENAME]: string;
                    [DATABASE.COLUMNS.DURATION]: number;
                    [DATABASE.COLUMNS.RESOLUTION]: string | null;
                }[]
            ) => {
                if (err) {
                    logger.error(`Failed to get metadata for ${filename} from database.`, { error: err });
                    return reject(err);
                }
                const metadata = new Map<string, SegmentMetadata>();
                rows.forEach((row) => {
                    metadata.set(row[DATABASE.COLUMNS.TS_FILENAME], { duration: row[DATABASE.COLUMNS.DURATION], resolution: row[DATABASE.COLUMNS.RESOLUTION] });
                });
                resolve(metadata);
            }
        );
    });
}

export async function getVideoDuration(filename: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const sql = `SELECT SUM(${DATABASE.COLUMNS.DURATION}) as ${DATABASE.COLUMNS.TOTAL_DURATION} FROM ${DATABASE.TABLES.DURATIONS} WHERE ${DATABASE.COLUMNS.VIDEO_FILENAME} = ?`;
        databaseService.db.get(sql, [filename], (err, row: { [DATABASE.COLUMNS.TOTAL_DURATION]: number | null }) => {
            if (err) {
                logger.error(`Failed to get total duration for ${filename} from database.`, { error: err });
                return reject(err);
            }
            resolve(row?.[DATABASE.COLUMNS.TOTAL_DURATION] || 0);
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

        const stmt = databaseService.db.prepare(
            `INSERT OR REPLACE INTO ${DATABASE.TABLES.DURATIONS} (${DATABASE.COLUMNS.VIDEO_FILENAME}, ${DATABASE.COLUMNS.TS_FILENAME}, ${DATABASE.COLUMNS.DURATION}, ${DATABASE.COLUMNS.RESOLUTION}) VALUES (?, ?, ?, ?)`
        );
        databaseService.db.serialize(() => {
            databaseService.db.run(DATABASE.QUERIES.BEGIN_TRANSACTION);
            cacheMisses.forEach((tsFile, index) => {
                const meta = newMetadata[index];
                stmt.run(filename, tsFile, meta.duration, meta.resolution);
            });
            databaseService.db.run(DATABASE.QUERIES.COMMIT, (err) => {
                if (err) {
                    logger.error(`Failed to commit metadata cache for ${filename}.`, { error: err });
                }
            });
        });
        stmt.finalize();
    }
    return metadata;
}
