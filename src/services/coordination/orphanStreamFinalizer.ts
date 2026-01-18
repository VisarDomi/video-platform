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
                let repairedCount = 0;

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

                        try {
                            const files = await fs.readdir(streamPath);
                            const tsFiles = files.filter(f => f.endsWith(".ts")).sort((a, b) => parseInt(a) - parseInt(b));

                            if (tsFiles.length > 0) {
                                // Check the first segment for "Bad Duration" issue (> 1 hour)
                                const firstSegment = tsFiles[0];
                                const firstSegmentPath = path.join(streamPath, firstSegment);

                                const isBad = await this.checkIfSegmentIsBad(firstSegmentPath);
                                if (isBad) {
                                    logger.warn(`Detected corrupt timestamps (>1h duration) in ${dirent.name}. Starting repair of ${tsFiles.length} segments...`);
                                    await this.repairSegments(streamPath, tsFiles);
                                    repairedCount++;

                                    // Backup playlist to force regeneration by backend
                                    const playlistPath = path.join(streamPath, "playlist.m3u8");
                                    const backupPath = path.join(streamPath, "playlist.m3u8.bak");
                                    try {
                                        await fs.rename(playlistPath, backupPath);
                                        logger.info(`Backed up playlist for ${dirent.name} to force regeneration after repair.`);
                                    } catch (e) { /* ignore if missing */ }
                                }
                            }
                        } catch (err: any) {
                            logger.error(`Error checking/repairing stream ${dirent.name}`, { error: err.message });
                        }
                    }
                }
                logger.info(`Orphan stream finalizer check complete. Scanned ${processedCount} folders. Repaired ${repairedCount} streams.`);
            } catch (error: any) {
                logger.error("Error during orphan stream finalization check:", { errorMessage: error.message });
            }
        })();
    }

    private static async checkIfSegmentIsBad(filePath: string): Promise<boolean> {
        try {
            // ffprobe to get duration.
            // -show_entries format=duration output is: duration=1234.56
            const cmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
            const { stdout } = await execAsync(cmd);
            const duration = parseFloat(stdout.trim());

            // If duration > 3600 seconds (1 hour), it is definitely a timestamp bug for a TS segment
            if (!isNaN(duration) && duration > 3600) {
                return true;
            }
            return false;
        } catch (error) {
            // If probe fails, we can't determine. Safest to leave it alone.
            return false;
        }
    }

    private static async repairSegments(streamPath: string, tsFiles: string[]): Promise<void> {
        for (const file of tsFiles) {
            const filePath = path.join(streamPath, file);
            const tempPath = path.join(streamPath, `${file}.temp.ts`);

            try {
                // -c copy rewrites container timestamps without re-encoding
                await execAsync(`ffmpeg -y -v error -i "${filePath}" -c copy "${tempPath}"`);

                // Atomic replace
                await fs.rename(tempPath, filePath);
            } catch (error: any) {
                logger.error(`Failed to repair segment ${file}`, { error: error.message });
                try { await fs.unlink(tempPath); } catch {}
            }
        }
    }
}