// src/combiner/combinerService.ts
import * as timersPromises from 'timers/promises';
import * as config from '../config.js';
import logger from '../logger.js';
import * as fileTracker from '../fileTracker.js';
import { combineShortVideos } from './combiner.js';

async function runCombinationCycle() {
    logger.info("[Combiner] Starting MP4 combination cycle...");
    const cfg = config.getConfig();
    const storageDir = cfg.storagePath;

    try {
        const allLocalFiles = await fileTracker.getLocalVideoFiles(storageDir);
        const processedFiles = await fileTracker.loadProcessedFiles();

        const unprocessedFiles = allLocalFiles.filter(file => !processedFiles.has(file));

        if (unprocessedFiles.length > 0) {
            await combineShortVideos(unprocessedFiles, storageDir);
        } else {
            logger.info("[Combiner] No new MP4 files to combine.");
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