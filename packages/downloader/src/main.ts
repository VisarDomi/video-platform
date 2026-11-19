import { DownloaderService } from "./services/downloaderService.js";
import logger from "./common/logger.js";

async function main() {
    const downloaderService = await DownloaderService.create();

    const shutdown = async (signal: string) => {
        logger.info(`Received ${signal}. Stopping active downloads without finalizing them...`);
        await downloaderService.shutdown();
        logger.info("Graceful shutdown complete.");
        process.exit(0);
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));

    await downloaderService.start();
}

// A startup failure (a missing or invalid sites file, a plug-in that does not load) is
// fatal: the service exits non-zero and systemd retries it.
main().catch((error: any) => {
    logger.error(`[General] Startup failed: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 1_000).unref();
});
