// src/combiner/combinerService.ts
import * as timersPromises from "timers/promises";
import * as fsPromises from "fs/promises";
import * as path from "path";

import * as config from "../config.js";
import logger from "../logger.js";

import * as fileTracker from "./fileTracker.js";
import * as combiner from "./combiner.js";

async function runCombinationCycle() {
    logger.info("[Combiner] Starting MP4 combination cycle...");
    const cfg = config.getConfig();
    const baseStorageDir = cfg.storagePath;
    const editedDir = path.join(baseStorageDir, "edited"); // The directory to watch

    try {
        // Ensure the directory exists before trying to read from it.
        await fsPromises.mkdir(editedDir, { recursive: true });

        const allLocalFiles = await fileTracker.getLocalVideoFiles(editedDir);
        const processedFiles = await fileTracker.loadProcessedFiles();

        const unprocessedFiles = allLocalFiles.filter((file) => !processedFiles.has(file));

        if (unprocessedFiles.length > 0) {
            // combineShortVideos takes the base directory to construct full paths
            await combiner.combineShortVideos(unprocessedFiles, editedDir);
        } else {
            logger.info("[Combiner] No new MP4 files to combine in 'edited' folder.");
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
        const scanInterval = config.getConfig().combiner.scanIntervalHours * 60 * 60 * 1000;
        await timersPromises.setTimeout(scanInterval);

        try {
            logger.info("Periodic MP4 combination scan triggered by manager.");
            await runCombinationCycle();
        } catch (error) {
            logger.error("An unexpected error occurred in the combiner service loop.", { error });
        }
    }
}
