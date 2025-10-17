import { DownloaderService } from "./services/downloaderService.js";

async function main() {
    const downloaderService = await DownloaderService.create();
    await downloaderService.start();
}

main();
