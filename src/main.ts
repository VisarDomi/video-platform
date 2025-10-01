// src/main.ts
import { DownloaderService } from "./downloader/downloaderService.js";

async function main() {
    const downloaderService = new DownloaderService();
    downloaderService.start();
}

main();
