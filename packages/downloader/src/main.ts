import { DownloaderService } from "./services/downloaderService.js";
import { createApiServer } from "./api/server.js";
import logger from "./common/logger.js";

async function main() {
    const downloaderService = await DownloaderService.create();

    const shutdown = async (signal: string) => {
        logger.info(`Received ${signal}. Shutting down services...`);
        process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    await downloaderService.start();

    const tsliveApiClient = downloaderService.getTsLiveApiClient();
    createApiServer(tsliveApiClient);
}

void main();
