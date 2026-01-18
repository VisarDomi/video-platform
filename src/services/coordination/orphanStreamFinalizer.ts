import * as fs from "fs/promises";
import * as path from "path";
import * as config from "../../common/config.js";
import { FileSystemManager } from "../../common/fileSystemManager.js";
import logger from "../../common/logger.js";
import { MediaValidator } from "../../common/mediaValidator.js";

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

                        // Check for bad segments using MediaValidator
                        try {
                            const files = await fs.readdir(streamPath);
                            const tsFiles = files.filter(f => f.endsWith(".ts")).sort((a, b) => parseInt(a) - parseInt(b));

                            let hasDeletions = false;

                            for (const file of tsFiles) {
                                const filePath = path.join(streamPath, file);
                                const isBad = await MediaValidator.isSegmentCorrupt(filePath);

                                if (isBad) {
                                    logger.warn(`Deleting corrupt segment (0kb/s or bad duration): ${file} in ${dirent.name}`);
                                    await fs.unlink(filePath);
                                    deletedBadSegments++;
                                    hasDeletions = true;
                                }
                            }

                            // Force playlist regeneration if segments were deleted
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
}