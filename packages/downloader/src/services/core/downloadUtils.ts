import * as path from "path";
import { config } from "../../common/config.js";
import { FileSystemManager } from "../../common/fileSystemManager.js";
import logger from "../../common/logger.js";

export function resolveSegmentUrl(baseUrl: string, segmentLine: string): string {
    try {
        return new URL(segmentLine, baseUrl).href;
    } catch {
        return segmentLine;
    }
}

export function formatDownloadDirName(alias: string, date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}${minutes}${seconds} ${alias}`;
}

export async function setupDownloadDir(providerName: string, alias: string, date: Date): Promise<string | null> {
    const baseName = formatDownloadDirName(alias, date);
    const storageLocation = path.join(config.storagePath, providerName, "downloader");

    const storageLocationExists = await FileSystemManager.ensureDirExists(storageLocation);
    if (!storageLocationExists) {
        logger.error(`[${providerName}] Could not create or access storage folder at: ${storageLocation}`);
        return null;
    }

    const segmentsDirPath = path.resolve(storageLocation, baseName);
    const segmentsDirExists = await FileSystemManager.ensureDirExists(segmentsDirPath);
    return segmentsDirExists ? segmentsDirPath : null;
}
