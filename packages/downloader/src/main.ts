import { DownloaderService } from "./services/downloaderService.js";
import logger from "./common/logger.js";

async function main() {
    const downloaderService = await DownloaderService.create();

    const shutdown = async (signal: string) => {
        logger.info(`Received ${signal}. Finalizing active downloads...`);
        await downloaderService.shutdown();
        logger.info("Graceful shutdown complete.");
        process.exit(0);
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));

    await downloaderService.start();
}

void main();
