// src/combiner/combinerService.ts
import * as timersPromises from "timers/promises";
import * as fsPromises from "fs/promises";
import * as path from "path";

import * as config from "../common/config.js";
import logger from "../common/logger.js";

import * as combiner from "./combiner.js";

async function runCombinationCycle() {
    logger.info("[Combiner] Starting MP4 combination cycle...");
    const cfg = config.getConfig();
    const editedDir = path.join(cfg.storagePath, "edited");

    try {
        // Ensure the directory to be scanned exists.
        await fsPromises.mkdir(editedDir, { recursive: true });

        // This loop implements the "restart from the beginning" logic.
        // It will continue to call combineShortVideos as long as it successfully finds and combines a batch.
        while (true) {
            const didCombine = await combiner.combineShortVideos(editedDir);

            if (didCombine) {
                // A combination happened. The file system has changed.
                // Loop again to re-scan from the beginning for new combination opportunities.
                logger.info("[Combiner] A batch was successfully combined. Re-scanning for more batches...");
            } else {
                // combineShortVideos returned false, meaning it scanned all available files
                // and found no new batches to create. The cycle is complete for now.
                break;
            }
        }
    } catch (error) {
        logger.error("[Combiner] An unexpected error occurred during the combination cycle.", { error });
    }
    logger.info("[Combiner] MP4 combination cycle finished.");
}

export async function startCombinerService() {
    if (!config.getConfig().combiner.enabled) {
        logger.warn("MP4 Combiner service is disabled via config.");
        return;
    }

    logger.info("Starting MP4 combiner service...");

    // Run once on startup
    await runCombinationCycle();

    while (true) {
        const scanIntervalHours = config.getConfig().combiner.scanIntervalHours;
        const scanInterval = scanIntervalHours * 60 * 60 * 1000;
        logger.info(`[Combiner] Waiting for next scan in ${scanIntervalHours} hours.`);
        await timersPromises.setTimeout(scanInterval);

        try {
            logger.info("[Combiner] Periodic MP4 combination scan triggered.");
            await runCombinationCycle();
        } catch (error) {
            logger.error("An unexpected error occurred in the combiner service loop.", { error });
        }
    }
}
