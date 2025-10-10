// src/main.ts
import { DownloaderService } from "./downloader/downloaderService.js";

async function main() {
    const downloaderService = await DownloaderService.create();
    await downloaderService.start();
}

main();
