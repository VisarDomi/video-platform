// src/main.ts
import 'dotenv/config';
import logger from './logger.js';
import { TokenManager } from './auth/tokenManager.js';
import { startDownloaderService } from './services/downloaderService.js';
import { startRepackagerService } from './services/repackagerService.js';

async function main() {
    logger.info("--- Starting Tango Downloader Service ---");
    
    // 1. Authenticate and get the context
    logger.info("Starting initial authentication...");
    const tokenManager = new TokenManager();
    await tokenManager.initialAuth();
    const authContext = tokenManager.getAuthContext();
    logger.info("Initial authentication successful.");
    
    // 2. Start the main application services
    startDownloaderService(authContext);
    startRepackagerService();
    
    // 3. Start background maintenance jobs
    tokenManager.startBackgroundJobs();
    
    logger.info("All services are running.");
}

main();