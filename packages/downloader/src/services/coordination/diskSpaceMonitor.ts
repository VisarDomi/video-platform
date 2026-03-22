import * as fs from "fs/promises";
import * as path from "path";
import * as url from "url";
import * as timersPromises from "timers/promises";
import { exec } from "child_process";

import logger from "../../common/logger.js";
import { config } from "../../common/config.js";
import * as utils from "../../common/utils.js";
import { DISK_CHECK_INTERVAL_MS, DISK_FULL_SLEEP_MS } from "../../common/timing.js";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class DiskSpaceMonitor {
    public static run(): void {
        const monitor = new DiskSpaceMonitor();
        void monitor.start();
    }

    private async start(): Promise<void> {
        logger.info("[System] DiskSpaceMonitor started.");

        while (true) {
            try {
                const stats = await fs.statfs(config.storagePath);
                const availableBytes = stats.bavail * stats.bsize;
                const limitBytes = 50 * 1024 * 1024 * 1024;

                if (availableBytes < limitBytes) {
                    logger.error(`[System] Disk space limit reached (<50GB). Stopping service to prevent loop.`);

                    const dateStr = new Date().toISOString().split("T")[0];
                    const markerPath = path.join(utils.findProjectRoot(__dirname), `no-more-space-${dateStr}.txt`);
                    await fs.writeFile(markerPath, "");

                    exec("systemctl --user stop video-downloader");

                    await timersPromises.setTimeout(DISK_FULL_SLEEP_MS);
                }
            } catch (error: any) {
                logger.error("[System] Error checking disk space:", { error: error.message });
            }

            await timersPromises.setTimeout(DISK_CHECK_INTERVAL_MS);
        }
    }
}