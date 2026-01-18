import * as fs from "fs/promises";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import * as config from "../../common/config.js";
import { FileSystemManager } from "../../common/fileSystemManager.js";
import logger from "../../common/logger.js";

const execAsync = promisify(exec);

interface LiveStatus {
    downloads: { segmentsDirPath: string | null }[];
}

export class OrphanStreamFinalizer {
    public static run(): void {
        (async () => {
            logger.info("Starting orphan stream finalizer check...");
            const cfg = config.getConfig();

            const streamsLocation = path.join(cfg.storagePath, "tango", "downloader");
            const statusFilePath = path.join(cfg.sharedStatePath, "live-status.json");

            let liveStreamPaths: Set<string>;

            const liveStatus = await FileSystemManager.readJsonFile<LiveStatus>(statusFilePath);
            if (liveStatus && liveStatus.downloads) {
                liveStreamPaths = new Set(
                    liveStatus.downloads
                        .map((d) => d.segmentsDirPath)
                        .filter(Boolean) as string[]
                );
            } else {
                liveStreamPaths = new Set();
            }

            try {
                try {
                    await fs.access(streamsLocation);
                } catch {
                    logger.info(`Stream location ${streamsLocation} does not exist. Skipping orphan stream check.`);
                    return;
                }

                const streamDirs = await fs.readdir(streamsLocation, { withFileTypes: true });
                let processedCount = 0;
                let deletedBadSegments = 0;

                for (const dirent of streamDirs) {
                    if (dirent.isDirectory()) {
                        const streamPath = path.join(streamsLocation, dirent.name);

                        // STALE CHECK
                        let isStale = false;
                        if (liveStreamPaths.has(streamPath)) {
                            try {
                                const stats = await fs.stat(streamPath);
                                const ageMs = Date.now() - stats.mtimeMs;
                                if (ageMs > 10 * 60 * 1000) { // 10 minutes
                                    isStale = true;
                                    logger.warn(`Stream marked as live but is stale (>10m old). Force finalizing: ${streamPath}`);
                                }
                            } catch (e) { /* ignore */ }
                        }

                        if (liveStreamPaths.has(streamPath) && !isStale) {
                            continue;
                        }

                        processedCount++;

                        // Check for bad segments (0kb/s or insane duration)
                        try {
                            const files = await fs.readdir(streamPath);
                            const tsFiles = files.filter(f => f.endsWith(".ts")).sort((a, b) => parseInt(a) - parseInt(b));

                            let hasDeletions = false;

                            for (const file of tsFiles) {
                                const filePath = path.join(streamPath, file);
                                const isBad = await this.checkIfSegmentIsBad(filePath);

                                if (isBad) {
                                    logger.warn(`Deleting corrupt segment (0kb/s or bad duration): ${file} in ${dirent.name}`);
                                    await fs.unlink(filePath);
                                    deletedBadSegments++;
                                    hasDeletions = true;
                                }
                            }

                            // If we deleted segments, we MUST force playlist regeneration to remove references to them
                            if (hasDeletions) {
                                const playlistPath = path.join(streamPath, "playlist.m3u8");
                                const backupPath = path.join(streamPath, "playlist.m3u8.bak");
                                try {
                                    if (await FileSystemManager.pathExists(playlistPath)) {
                                        await fs.rename(playlistPath, backupPath);
                                        logger.info(`Backed up playlist for ${dirent.name} to force regeneration after cleanup.`);
                                    }
                                } catch (e) { /* ignore */ }
                            }
                        } catch (err: any) {
                            logger.error(`Error processing stream ${dirent.name}`, { error: err.message });
                        }
                    }
                }
                logger.info(`Orphan stream finalizer check complete. Scanned ${processedCount} folders. Deleted ${deletedBadSegments} corrupt segments.`);
            } catch (error: any) {
                logger.error("Error during orphan stream finalization check:", { errorMessage: error.message });
            }
        })();
    }

    public static async checkIfSegmentIsBad(filePath: string): Promise<boolean> {
        try {
            // Check bitrate and duration
            const cmd = `ffprobe -v error -show_entries format=duration,bit_rate -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
            const { stdout } = await execAsync(cmd);
            const lines = stdout.trim().split('\n');

            // Output order depends on ffprobe version/file, but usually:
            // duration
            // bit_rate
            // We parse all numbers found.

            // NOTE: ffprobe output might be just one line if one is missing.
            // Safe parsing:
            const values = lines.map(l => parseFloat(l)).filter(n => !isNaN(n));

            // We expect at least one value.
            // If bit_rate is missing or "N/A", it might not be parsed.
            // If bitrate is 0, it's bad.
            // If duration > 3600, it's bad.

            // Standard approach: check if string output contains "bit_rate=N/A" or value 0.
            // Actually, with :nokey=1, we just get numbers.
            // Let's use JSON format for robustness.
            const jsonCmd = `ffprobe -v error -show_format -of json "${filePath}"`;
            const { stdout: jsonStdout } = await execAsync(jsonCmd);
            const data = JSON.parse(jsonStdout);

            const duration = parseFloat(data.format.duration);
            const bitRate = parseFloat(data.format.bit_rate);

            // Condition 1: Bitrate is effectively 0 or N/A (NaN)
            // Note: valid TS files usually have > 100k bitrate.
            if (isNaN(bitRate) || bitRate < 1000) { // < 1kbps
                return true;
            }

            // Condition 2: Insane Duration (> 1 hour) for a segment
            if (!isNaN(duration) && duration > 3600) {
                return true;
            }

            return false;
        } catch (error) {
            // If ffprobe fails completely (corrupt file header), treat as bad.
            return true;
        }
    }
}