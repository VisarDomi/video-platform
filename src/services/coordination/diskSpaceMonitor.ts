import * as fs from "fs/promises";
import * as path from "path";
import * as url from "url";
import * as timersPromises from "timers/promises";

import logger from "../../common/logger.js";
import * as config from "../../common/config.js";
import * as utils from "../../common/utils.js";

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
                const cfg = config.getConfig();
                const stats = await fs.statfs(cfg.storagePath);
                const availableBytes = stats.bavail * stats.bsize;
                const limitBytes = 50 * 1024 * 1024 * 1024; // 50GB

                if (availableBytes < limitBytes) {
                    const dateStr = new Date().toISOString().split("T")[0];
                    const fileName = `no-more-space-${dateStr}.txt`;
                    const projectRoot = utils.findProjectRoot(__dirname);
                    const markerPath = path.join(projectRoot, fileName);

                    // Create empty file
                    await fs.writeFile(markerPath, "");

                    logger.error(`[System] Disk space limit reached (<50GB). Marker created at ${markerPath}. Exiting immediately.`);
                    process.exit(1);
                }
            } catch (error: any) {
                logger.error("[System] Error checking disk space:", { error: error.message });
            }

            // Check every minute
            await timersPromises.setTimeout(60 * 1000);
        }
    }
}