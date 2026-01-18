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

            // FIX: Point to the actual stream location, not just the root storage path
            const streamsLocation = path.join(cfg.storagePath, "tango", "downloader");
            const statusFilePath = path.join(cfg.sharedStatePath, "live-status.json");

            let liveStreamPaths: Set<string>;

            const liveStatus = await FileSystemManager.readJsonFile<LiveStatus>(statusFilePath);
            if (liveStatus && liveStatus.downloads) {
                liveStreamPaths = new Set(liveStatus.downloads.map((d) => d.segmentsDirPath).filter(Boolean) as string[]);
            } else {
                liveStreamPaths = new Set();
            }

            if (liveStreamPaths.size > 0) {
                logger.info(`Found ${liveStreamPaths.size} live streams to ignore during finalization.`);
            }

            try {
                // Check if directory exists first
                try {
                    await fs.access(streamsLocation);
                } catch {
                    logger.info(`Stream location ${streamsLocation} does not exist. Skipping orphan stream check.`);
                    return;
                }

                const streamDirs = await fs.readdir(streamsLocation, { withFileTypes: true });
                let processedCount = 0;
                let fixedCount = 0;

                for (const dirent of streamDirs) {
                    if (dirent.isDirectory()) {
                        const streamPath = path.join(streamsLocation, dirent.name);

                        // STALE CHECK: If it claims to be live, but hasn't been touched in 10 mins, force finalize it.
                        let isStale = false;
                        if (liveStreamPaths.has(streamPath)) {
                            try {
                                const stats = await fs.stat(streamPath);
                                const ageMs = Date.now() - stats.mtimeMs;
                                if (ageMs > 10 * 60 * 1000) { // 10 minutes
                                    isStale = true;
                                    logger.warn(`Stream marked as live but is stale (>10m old). Force finalizing: ${streamPath}`);
                                }
                            } catch (e) { /* ignore stat error */ }
                        }

                        if (liveStreamPaths.has(streamPath) && !isStale) {
                            logger.verbose(`Skipping active stream: ${streamPath}`);
                            continue;
                        }

                        processedCount++;
                        const playlistPath = path.join(streamPath, "playlist.m3u8");
                        const content = await FileSystemManager.readFile(playlistPath);

                        if (content) {
                            let shouldRewrite = false;
                            let lines = content.split("\n");
                            let maxDuration = 0;
                            let currentTarget = 0;

                            // 1. Scan for Max Duration and Current Target
                            for (const line of lines) {
                                if (line.startsWith("#EXTINF:")) {
                                    // Remove #EXTINF: and trailing comma if present
                                    const valStr = line.substring(8).replace(",", "").trim();
                                    const duration = parseFloat(valStr);
                                    if (!isNaN(duration) && duration > maxDuration) {
                                        maxDuration = duration;
                                    }
                                } else if (line.startsWith("#EXT-X-TARGETDURATION:")) {
                                    currentTarget = parseInt(line.split(":")[1], 10);
                                }
                            }

                            // 2. Determine necessary target
                            // Math.ceil(1.001) -> 2. If target is 1, 2 > 1, so update.
                            const necessaryTarget = Math.ceil(maxDuration);

                            // 3. Update Target Duration if necessary
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

                            // 4. Ensure ENDLIST exists
                            if (!content.includes("#EXT-X-ENDLIST")) {
                                logger.info(`Finalizing orphaned stream playlist (missing ENDLIST): ${dirent.name}`);
                                lines.push("#EXT-X-ENDLIST");
                                shouldRewrite = true;
                            }

                            if (shouldRewrite) {
                                const newContent = lines.join("\n").trim() + "\n";
                                await FileSystemManager.writeFile(playlistPath, newContent);
                                fixedCount++;
                            }
                        }
                    }
                }
                logger.info(`Orphan stream finalizer check complete. Scanned ${processedCount} folders in ${streamsLocation}. Fixed/Updated ${fixedCount} playlists.`);
            } catch (error: any) {
                logger.error("Error during orphan stream finalization check:", { errorMessage: error.message });
            }
        })();
    }
}