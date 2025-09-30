// src/main.ts
import 'dotenv/config';
import logger from './logger.js';
import * as config from './config.js'; // Import config
import { TokenManager } from './auth/tokenManager.js';
import { startDownloaderService } from './services/downloaderService.js';
import { startRepackagerService } from './services/repackagerService.js';

async function main() {
    logger.info("--- Starting Tango Downloader Service ---");
    const cfg = config.getConfig();
    
    // 1. Authenticate and get the context
    logger.info("Starting initial authentication...");
    const tokenManager = new TokenManager();
    await tokenManager.initialAuth();
    const authContext = tokenManager.getAuthContext();
    logger.info("Initial authentication successful.");
    
    // 2. Start the main application services based on config
    if (cfg.downloader.enabled) {
        startDownloaderService(authContext);
    } else {
        logger.warn("Downloader service is disabled via config.");
    }
    
    if (cfg.repackager.enabled) {
        startRepackagerService();
    } else {
        logger.warn("Repackager service is disabled via config.");
    }
    
    // 3. Start background maintenance jobs
    tokenManager.startBackgroundJobs();
    
    logger.info("All services are running.");
}

main();