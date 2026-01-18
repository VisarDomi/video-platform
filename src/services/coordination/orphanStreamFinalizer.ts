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

                        // Check for "Bad Duration" issue (26h duration artifact)
                        // We check the first available .ts file
                        try {
                            const files = await fs.readdir(streamPath);
                            const tsFiles = files.filter(f => f.endsWith(".ts")).sort((a, b) => parseInt(a) - parseInt(b));

                            if (tsFiles.length > 0) {
                                const firstSegment = tsFiles[0];
                                const firstSegmentPath = path.join(streamPath, firstSegment);

                                const isBad = await this.checkIfSegmentIsBad(firstSegmentPath);
                                if (isBad) {
                                    logger.warn(`Detected corrupt timestamps (26h bug) in ${dirent.name}. Starting repair of ${tsFiles.length} segments...`);
                                    await this.repairSegments(streamPath, tsFiles);
                                    repairedCount++;

                                    // After repair, we MUST force playlist regeneration because previous durations were wrong
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
            // Use ffprobe to get duration.
            // Output format: duration="1234.56"
            const cmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
            const { stdout } = await execAsync(cmd);
            const duration = parseFloat(stdout.trim());

            // If duration is > 300 seconds (5 mins) for a single TS segment, it's likely the 26h bug.
            // Normal segments are ~1-10s.
            if (!isNaN(duration) && duration > 300) {
                return true;
            }
            return false;
        } catch (error) {
            // If ffprobe fails, we assume it's weird or we can't check.
            // Safest to NOT touch it if we aren't sure.
            return false;
        }
    }

    private static async repairSegments(streamPath: string, tsFiles: string[]): Promise<void> {
        // We process in batches to avoid overwhelming the system, but sequentially is safer for simple scripts.
        for (const file of tsFiles) {
            const filePath = path.join(streamPath, file);
            const tempPath = path.join(streamPath, `${file}.temp.ts`);

            try {
                // -c copy rewrites container timestamps
                await execAsync(`ffmpeg -y -v error -i "${filePath}" -c copy "${tempPath}"`);

                // Overwrite original
                await fs.rename(tempPath, filePath);
            } catch (error: any) {
                logger.error(`Failed to repair segment ${file}`, { error: error.message });
                // Clean up temp if exists
                try { await fs.unlink(tempPath); } catch {}
            }
        }
    }
}