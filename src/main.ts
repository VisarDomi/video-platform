// src/main.ts
import { DownloaderService } from "./downloader/downloaderService.js";
import { GrowerService } from "./grower/growerService.js";

async function main() {
    const downloaderService = await DownloaderService.create();
    downloaderService.start();

    const growerService = new GrowerService();
    growerService.start();
}

main();