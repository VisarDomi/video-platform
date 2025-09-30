// src/main.ts
import 'dotenv/config';
import logger from './logger.js';
import * as config from './config.js';
import { TokenManager } from './auth/tokenManager.js';
import { startDownloaderService } from './downloaderService.js';
import { startAssemblerService } from './assembler/assemblerService.js';
import { startCombinerService } from './combiner/combinerService.js';

async function main() {
    logger.info("--- Starting Tango Downloader Service ---");
    const cfg = config.getConfig();
    
    logger.info("Starting initial authentication...");
    const tokenManager = new TokenManager();
    await tokenManager.initialAuth();
    logger.info("Initial authentication successful.");
    
    if (cfg.downloader.enabled) {
        startDownloaderService();
    } else {
        logger.warn("Downloader service is disabled via config.");
    }
    
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
    
    tokenManager.startBackgroundJobs();
    
    logger.info("All services are running.");
}

main();