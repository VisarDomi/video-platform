import * as fs from "fs/promises";
import * as path from "path";
import * as config from "../../common/config.js";
import { FileSystemManager } from "../../common/fileSystemManager.js";
import logger from "../../common/logger.js";
import { DownloadsManager } from "../state/downloadsManager.js";

export class OrphanStreamFinalizer {
    private downloadsManager: DownloadsManager;
    private readonly checkInterval: number = 24 * 60 * 60 * 1000; // 24 hours

    constructor(downloadsManager: DownloadsManager) {
        this.downloadsManager = downloadsManager;
    }

    public start(): void {
        const runLoop = async () => {
            await this.processOrphans();
            setTimeout(runLoop, this.checkInterval);
        };
        // Run immediately to clean up from potential previous crashes
        void runLoop();
    }

    private async processOrphans(): Promise<void> {
        logger.info("Starting orphan stream finalizer check...");
        const cfg = config.getConfig();
        const streamsLocation = path.join(cfg.storagePath, "tango", "downloader");

        const activePaths = this.downloadsManager.getActiveSegmentPaths();

        try {
            try {
                await fs.access(streamsLocation);
            } catch {
                logger.info(`Stream location ${streamsLocation} does not exist. Skipping orphan stream check.`);
                return;
            }

            const streamDirs = await fs.readdir(streamsLocation, { withFileTypes: true });
            let processedCount = 0;
            let fixedPlaylists = 0;

            for (const dirent of streamDirs) {
                if (dirent.isDirectory()) {
                    const streamPath = path.join(streamsLocation, dirent.name);

                    // Skip currently active downloads
                    if (activePaths.has(streamPath)) {
                        continue;
                    }

                    // Safety check: ensure the folder isn't brand new
                    try {
                        const stats = await fs.stat(streamPath);
                        const ageMs = Date.now() - stats.mtimeMs;
                        if (ageMs < 2 * 60 * 1000) {
                            continue;
                        }
                    } catch (e) {
                        continue;
                    }

                    processedCount++;

                    // Sync Playlist and Finalize
                    try {
                        const playlistPath = path.join(streamPath, "playlist.m3u8");
                        if (await FileSystemManager.pathExists(playlistPath)) {
                            const content = await FileSystemManager.readFile(playlistPath);
                            if (content) {
                                // 1. Get list of actual files on disk
                                const filesOnDisk = new Set(await fs.readdir(streamPath));

                                // 2. Rebuild playlist based on file existence
                                const lines = content.split("\n");
                                const newLines: string[] = [];
                                const metadataBuffer: string[] = [];
                                let hasChanges = false;

                                for (const line of lines) {
                                    const trimmed = line.trim();
                                    if (trimmed === "") continue;

                                    if (trimmed.startsWith("#")) {
                                        // Always keep headers
                                        if (
                                            trimmed.startsWith("#EXTM3U") ||
                                            trimmed.startsWith("#EXT-X-VERSION") ||
                                            trimmed.startsWith("#EXT-X-TARGETDURATION") ||
                                            trimmed.startsWith("#EXT-X-MEDIA-SEQUENCE") ||
                                            trimmed.startsWith("#EXT-X-ENDLIST")
                                        ) {
                                            newLines.push(trimmed);
                                        } else {
                                            // Buffer metadata (EXTINF, EXT-X-PROGRAM-DATE-TIME) until we confirm file exists
                                            metadataBuffer.push(trimmed);
                                        }
                                    } else {
                                        // This is a file entry
                                        if (filesOnDisk.has(trimmed)) {
                                            newLines.push(...metadataBuffer);
                                            newLines.push(trimmed);
                                            metadataBuffer.length = 0;
                                        } else {
                                            // File missing from disk, discard buffer and skip this line
                                            hasChanges = true;
                                            metadataBuffer.length = 0;
                                            logger.info(`Removing missing segment from orphan playlist: ${trimmed} in ${dirent.name}`);
                                        }
                                    }
                                }

                                // 3. Ensure Endlist
                                const hasEndList = newLines.some((l) => l.startsWith("#EXT-X-ENDLIST"));
                                if (!hasEndList) {
                                    newLines.push("#EXT-X-ENDLIST");
                                    hasChanges = true;
                                }

                                if (hasChanges) {
                                    await FileSystemManager.writeFile(playlistPath, newLines.join("\n") + "\n");
                                    fixedPlaylists++;
                                }
                            }
                        }
                    } catch (err: any) {
                        logger.error(`Error finalizing playlist for orphan ${dirent.name}`, { error: err.message });
                    }
                }
            }
            logger.info(`Orphan stream finalizer check complete. Scanned ${processedCount} orphans. Fixed/Synced ${fixedPlaylists} playlists.`);
        } catch (error: any) {
            logger.error("Error during orphan stream finalization check:", { errorMessage: error.message });
        }
    }
}