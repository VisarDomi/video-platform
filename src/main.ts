// src/main.ts
import { DownloaderService } from "./downloader/downloaderService.js";

async function main() {
    const downloaderService = await DownloaderService.create();
    downloaderService.start();
}

main();