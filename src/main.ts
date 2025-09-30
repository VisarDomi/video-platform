// src/main.ts
import "dotenv/config";

import logger from "./common/logger.js";
import * as config from "./common/config.js";
import { AuthService } from "./auth/authService.js";
import { DownloaderService } from "./downloader/downloaderService.js";
import { startAssemblerService } from "./assembler/assemblerService.js";
import { startCombinerService } from "./combiner/combinerService.js";

async function main() {
    logger.info("--- Starting Tango Downloader Service ---");
    const cfg = config.getConfig();

    logger.info("Starting initial authentication...");
    const authService = new AuthService();
    await authService.initiateAuth();
    authService.startBackgroundJobs();
    logger.info("Initial authentication successful.");

    if (cfg.downloader.enabled) {
        const downloaderService = new DownloaderService();
        downloaderService.start();
    } else {
        logger.warn("Downloader service is disabled via config.");
    }
    
    // ... (rest of the services start as before)
    if (cfg.repackager.enabled) {
        startAssemblerService();
    } else {
        logger.warn("Segment Assembler service is disabled via config.");
    }

    if (cfg.combiner.enabled) {
        startCombinerService();
    } else {
        logger.warn("MP4 Combiner service is disabled via config.");
    }

    logger.info("All enabled services are running.");
}

main();