// src/common/storage.ts
import * as path from "path";

import * as config from "./config.js";
import logger from "./logger.js";
import { FileSystemManager } from "../downloader/fileSystemManager.js";

function generateDownloadBaseName(alias: string, date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}${minutes}${seconds} ${alias}`;
}

export async function createDownloadPaths(alias: string, date: Date): Promise<string | null> {
    const baseFilename = generateDownloadBaseName(alias, date);
    const storageLocation = config.getConfig().storagePath;

    const storageLocationExists = await FileSystemManager.ensureDirExists(storageLocation);
    if (!storageLocationExists) {
        logger.error(`Could not create or access storage folder at: ${storageLocation}`);
        return null;
    }

    const segmentsDirPath = path.resolve(storageLocation, baseFilename);

    const segmentsDirExists = await FileSystemManager.ensureDirExists(segmentsDirPath);
    if (!segmentsDirExists) {
        logger.error(`Could not create segments folder at: ${segmentsDirPath}`);
        return null;
    }

    return segmentsDirPath;
}
