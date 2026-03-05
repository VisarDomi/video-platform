import * as fs from "fs/promises";
import * as path from "path";
import * as config from "../../common/config.js";
import { FileSystemManager } from "../../common/fileSystemManager.js";
import logger from "../../common/logger.js";
import { fixTargetDuration } from "shared";
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
        logger.info("[System] Starting orphan stream finalizer check...");
        const cfg = config.getConfig();
        const activePaths = this.downloadsManager.getActiveSegmentPaths();

        // Providers that use .ts segment folders (not mp4 or other formats)
        const services = ["tango", "fc2", "sc"];

        let totalProcessed = 0;
        let totalFixed = 0;
        let totalDeleted = 0;

        for (const service of services) {
            const streamsLocation = path.join(cfg.storagePath, service, "downloader");
            const stats = await this.cleanServiceDirectory(streamsLocation, activePaths);

            totalProcessed += stats.processed;
            totalFixed += stats.fixed;
            totalDeleted += stats.deleted;
        }

        logger.info(
            `[System] Orphan stream finalizer check complete. Scanned ${totalProcessed} orphans. Deleted ${totalDeleted} empty folders. Fixed/Synced ${totalFixed} playlists.`
        );
    }

    private async cleanServiceDirectory(streamsLocation: string, activePaths: Set<string>): Promise<{ processed: number, fixed: number, deleted: number }> {
        const stats = { processed: 0, fixed: 0, deleted: 0 };

        try {
            try {
                await fs.access(streamsLocation);
            } catch {
                // Folder doesn't exist, which is fine for a new service or fresh install
                return stats;
            }

            const streamDirs = await fs.readdir(streamsLocation, { withFileTypes: true });

            for (const dirent of streamDirs) {
                if (dirent.isDirectory()) {
                    const streamPath = path.join(streamsLocation, dirent.name);

                    // Skip currently active downloads
                    if (activePaths.has(streamPath)) {
                        continue;
                    }

                    // Safety check: ensure the folder isn't brand new
                    try {
                        const fileStats = await fs.stat(streamPath);
                        const ageMs = Date.now() - fileStats.mtimeMs;
                        if (ageMs < 2 * 60 * 1000) {
                            continue;
                        }
                    } catch (e) {
                        continue;
                    }

                    stats.processed++;

                    try {
                        const allFiles = await fs.readdir(streamPath);
                        const tsFiles = allFiles.filter((f) => f.endsWith(".ts"));

                        // DELETE EMPTY FOLDERS
                        if (tsFiles.length === 0) {
                            logger.info(`[System] Orphan folder ${dirent.name} contains no segments. Deleting folder.`);
                            await fs.rm(streamPath, { recursive: true, force: true });
                            stats.deleted++;
                            continue;
                        }

                        // Sync Playlist and Finalize
                        const playlistPath = path.join(streamPath, "playlist.m3u8");
                        if (await FileSystemManager.pathExists(playlistPath)) {
                            const content = await FileSystemManager.readFile(playlistPath);
                            if (content) {
                                // 1. Get list of actual files on disk
                                const filesOnDisk = new Set(allFiles);

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
                                            // Buffer metadata until we confirm file exists
                                            metadataBuffer.push(trimmed);
                                        }
                                    } else {
                                        // This is a file entry
                                        if (filesOnDisk.has(trimmed)) {
                                            newLines.push(...metadataBuffer);
                                            newLines.push(trimmed);
                                            metadataBuffer.length = 0;
                                        } else {
                                            // File missing from disk, discard buffer
                                            hasChanges = true;
                                            metadataBuffer.length = 0;
                                            logger.info(`[System] Removing missing segment from orphan playlist: ${trimmed} in ${dirent.name}`);
                                        }
                                    }
                                }

                                // 3. Ensure Endlist
                                const hasEndList = newLines.some((l) => l.startsWith("#EXT-X-ENDLIST"));
                                if (!hasEndList) {
                                    newLines.push("#EXT-X-ENDLIST");
                                    hasChanges = true;
                                }

                                let finalContent = newLines.join("\n") + "\n";
                                const { content: fixedContent, wasFixed } = fixTargetDuration(finalContent);
                                if (wasFixed) {
                                    finalContent = fixedContent;
                                    hasChanges = true;
                                }

                                if (hasChanges) {
                                    await FileSystemManager.writeFile(playlistPath, finalContent);
                                    stats.fixed++;
                                }
                            }
                        }
                    } catch (err: any) {
                        logger.error(`[System] Error processing orphan ${dirent.name}`, { error: err.message });
                    }
                }
            }
        } catch (error: any) {
            logger.error(`[System] Error processing directory ${streamsLocation}`, { errorMessage: error.message });
        }

        return stats;
    }
}