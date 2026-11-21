import * as fs from "fs/promises";
import * as path from "path";
import * as timersPromises from "timers/promises";
import { exec } from "child_process";
import logger from "../core/logger.js";
import { defaultProvider, getProviderPaths } from "../core/config.js";

const DISK_CHECK_INTERVAL_MS = 60_000;
const DISK_LIMIT_BYTES = 50 * 1024 * 1024 * 1024;

// The file system of a path, measured at its nearest existing folder: on a fresh
// installation the downloads folder appears with the first recording.
export async function statfsNearest(target: string): Promise<import("fs").StatsFs> {
    for (let current = path.resolve(target); ; current = path.dirname(current)) {
        try {
            return await fs.statfs(current);
        } catch (error: any) {
            if (error?.code !== "ENOENT" || path.dirname(current) === current) throw error;
        }
    }
}

export function startDiskSpaceMonitor(): void {
    // The downloads disk, measured at the first capture site's folder (as it always was).
    const storagePath = getProviderPaths(defaultProvider()).downloaded;

    const run = async () => {
        logger.debug("[System] DiskSpaceMonitor started.");
        while (true) {
            try {
                const stats = await statfsNearest(storagePath);
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
