import { DownloaderService } from "./services/downloaderService.js";
import logger from "./common/logger.js";

async function main() {
    const downloaderService = await DownloaderService.create();

    // Handle graceful shutdown
    const shutdown = async (signal: string) => {
        logger.info(`Received ${signal}. Shutting down services...`);
        // We need a public stop method on DownloaderService to kill browsers
        // For now, we rely on the OS cleaning up the process tree,
        // but explicit cleanup is better.
        process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    await downloaderService.start();
}

void main();