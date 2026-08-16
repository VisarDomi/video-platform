import * as fs from "fs/promises";
import * as timersPromises from "timers/promises";
import { exec } from "child_process";
import logger from "../core/logger.js";
import { getProviderPaths } from "../core/config.js";

const DISK_CHECK_INTERVAL_MS = 60_000;
const DISK_LIMIT_BYTES = 50 * 1024 * 1024 * 1024;

export function startDiskSpaceMonitor(): void {
    const storagePath = getProviderPaths("tango").downloaded;

    const run = async () => {
        logger.info("[System] DiskSpaceMonitor started.");
        while (true) {
            try {
                const stats = await fs.statfs(storagePath);
                const availableBytes = stats.bavail * stats.bsize;

                if (availableBytes < DISK_LIMIT_BYTES) {
                    logger.error(`[System] Disk space limit reached (<50GB). Stopping video-downloader.`);
                    exec("systemctl --user stop video-downloader");
                }
            } catch (error: any) {
                logger.error("[System] Error checking disk space:", { error: error.message });
            }
            await timersPromises.setTimeout(DISK_CHECK_INTERVAL_MS);
        }
    };

    void run();
}
