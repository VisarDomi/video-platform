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
            const storagePath = cfg.storagePath;
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
                const streamDirs = await fs.readdir(storagePath, { withFileTypes: true });

                for (const dirent of streamDirs) {
                    if (dirent.isDirectory()) {
                        const streamPath = path.join(storagePath, dirent.name);

                        if (liveStreamPaths.has(streamPath)) {
                            logger.verbose(`Skipping finalization for active stream: ${streamPath}`);
                            continue;
                        }

                        const playlistPath = path.join(streamPath, "playlist.m3u8");

                        const content = await FileSystemManager.readFile(playlistPath);
                        if (content && !content.includes("#EXT-X-ENDLIST")) {
                            logger.info(`Finalizing orphaned stream playlist: ${playlistPath}`);
                            await FileSystemManager.appendFile(playlistPath, "#EXT-X-ENDLIST\n");
                        }
                    }
                }
            } catch (error: any) {
                if (error.code === "ENOENT") {
                    logger.info(`Storage path ${storagePath} does not exist. Skipping orphan stream check.`);
                } else {
                    logger.error("Error during orphan stream finalization check:", { errorMessage: error.message });
                }
            }

            logger.info("Orphan stream finalizer check complete.");
        })();
    }
}
