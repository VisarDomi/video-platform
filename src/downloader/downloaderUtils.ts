// src/downloader/downloaderUtils.ts
import * as fs from "fs";
import * as path from "path";

import * as config from "../config.js";
import logger from "../logger.js";


export function getFormattedDate(date: Date = new Date()): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}${minutes}${seconds}`;
}

export function generateDownloadBaseName(alias: string, date: Date): string {
    const formattedDate = getFormattedDate(date);
    return `${formattedDate} ${alias}`;
}

export interface DownloadPaths {
    tsFilePath: string;
    segmentsDirPath: string;
}

export function createDownloadPaths(alias: string, date: Date): DownloadPaths {
    const baseFilename = generateDownloadBaseName(alias, date);
    const storageLocation = config.getConfig().storagePath;

    if (!fs.existsSync(storageLocation)) {
        fs.mkdirSync(storageLocation, { recursive: true });
        logger.info(`Storage folder created at: ${storageLocation}`);
    }

    const tsFilePath = path.resolve(storageLocation, `${baseFilename}.ts`);
    const segmentsDirPath = path.resolve(storageLocation, baseFilename);

    if (!fs.existsSync(segmentsDirPath)) {
        fs.mkdirSync(segmentsDirPath, { recursive: true });
    }

    return { tsFilePath, segmentsDirPath };
}
