import * as fs from "fs/promises";
import * as path from "path";
import * as config from "../../common/config.js";
import { FileSystemManager } from "../../common/fileSystemManager.js";
import logger from "../../common/logger.js";

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
                // Ensure we compare absolute paths or consistent relative paths
                liveStreamPaths = new Set(
                    liveStatus.downloads
                        .map((d) => d.segmentsDirPath)
                        .filter(Boolean) as string[]
                );
            } else {
                liveStreamPaths = new Set();
            }

            if (liveStreamPaths.size > 0) {
                logger.info(`Found ${liveStreamPaths.size} live streams to ignore during finalization.`);
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
                let fixedCount = 0;
                let renamedFilesCount = 0;

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
                            logger.verbose(`Skipping active stream: ${streamPath}`);
                            continue;
                        }

                        // 1. CLEANUP FILE NAMES (Remove trailing \r)
                        try {
                            const files = await fs.readdir(streamPath);
                            for (const file of files) {
                                if (file.endsWith("\r")) {
                                    const oldPath = path.join(streamPath, file);
                                    const newPath = path.join(streamPath, file.trim()); // trim removes \r
                                    await fs.rename(oldPath, newPath);
                                    renamedFilesCount++;
                                }
                            }
                        } catch (err: any) {
                            logger.warn(`Failed to cleanup filenames in ${streamPath}: ${err.message}`);
                        }

                        // 2. FINALIZE PLAYLIST
                        processedCount++;
                        const playlistPath = path.join(streamPath, "playlist.m3u8");
                        const content = await FileSystemManager.readFile(playlistPath);

                        if (content) {
                            let shouldRewrite = false;
                            // Split by newline, handling \r gracefully by trimming lines later
                            let lines = content.split("\n");

                            // Check if any line has \r that needs stripping
                            const hasCR = content.includes("\r");
                            if (hasCR) {
                                shouldRewrite = true;
                                lines = lines.map(l => l.trim());
                            }

                            let maxDuration = 0;
                            let currentTarget = 0;

                            // Scan for Max Duration and Current Target
                            for (const line of lines) {
                                const trimmed = line.trim();
                                if (trimmed.startsWith("#EXTINF:")) {
                                    const valStr = trimmed.substring(8).replace(",", "").trim();
                                    const duration = parseFloat(valStr);
                                    if (!isNaN(duration) && duration > maxDuration) {
                                        maxDuration = duration;
                                    }
                                } else if (trimmed.startsWith("#EXT-X-TARGETDURATION:")) {
                                    currentTarget = parseInt(trimmed.split(":")[1], 10);
                                }
                            }

                            const necessaryTarget = Math.ceil(maxDuration);

                            if (necessaryTarget > 0 && necessaryTarget > currentTarget) {
                                logger.info(`Fixing TARGETDURATION for ${dirent.name}: ${currentTarget} -> ${necessaryTarget} (Max segment: ${maxDuration})`);
                                lines = lines.map(line => {
                                    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
                                        return `#EXT-X-TARGETDURATION:${necessaryTarget}`;
                                    }
                                    return line;
                                });
                                shouldRewrite = true;
                            }

                            if (!content.includes("#EXT-X-ENDLIST")) {
                                logger.info(`Finalizing orphaned stream playlist (missing ENDLIST): ${dirent.name}`);
                                lines.push("#EXT-X-ENDLIST");
                                shouldRewrite = true;
                            }

                            if (shouldRewrite) {
                                // Join with \n, ensuring last line ends with \n
                                const newContent = lines.join("\n").trim() + "\n";
                                await FileSystemManager.writeFile(playlistPath, newContent);
                                fixedCount++;
                            }
                        }
                    }
                }
                logger.info(`Orphan stream finalizer check complete. Scanned ${processedCount} folders. Fixed ${fixedCount} playlists. Renamed ${renamedFilesCount} files.`);
            } catch (error: any) {
                logger.error("Error during orphan stream finalization check:", { errorMessage: error.message });
            }
        })();
    }
}