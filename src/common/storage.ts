// src/common/storage.ts
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";

import * as config from "./config.js";
import logger from "./logger.js";
import * as utils from "./utils.js";

export interface DownloadPaths {
    tsFilePath: string;
    segmentsDirPath: string;
}

function generateDownloadBaseName(alias: string, date: Date): string {
    const formattedDate = utils.getFormattedDate(date);
    return `${formattedDate} ${alias}`;
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

export async function moveToTrash(sourcePath: string) {
    const storagePath = config.getConfig().storagePath;
    const trashDir = path.join(storagePath, "trash");

    try {
        await fsPromises.stat(sourcePath);
    } catch (error: any) {
        if (error.code === "ENOENT") {
            logger.verbose(`Source path to be trashed does not exist, skipping: ${path.basename(sourcePath)}`);
            return;
        }
        logger.error(`Error checking source path before moving to trash: ${sourcePath}`, { error });
        return;
    }

    try {
        await fsPromises.mkdir(trashDir, { recursive: true });
        const baseName = path.basename(sourcePath);
        const destPath = path.join(trashDir, baseName);
        await fsPromises.rename(sourcePath, destPath);
        logger.info(`Moved to trash: ${baseName}`);
    } catch (error: any) {
        if (error.code === "EEXIST" || error.code === "ENOTEMPTY") {
            try {
                const baseName = path.basename(sourcePath);
                const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
                const newDestPath = path.join(trashDir, `${timestamp}-${baseName}`);
                await fsPromises.rename(sourcePath, newDestPath);
                logger.info(`Moved to trash with new name: ${path.basename(newDestPath)}`);
            } catch (retryError) {
                logger.error(`Failed to move to trash (even with retry): ${sourcePath}`, { error: retryError });
            }
        } else {
            logger.error(`Failed to move to trash: ${sourcePath}`, { error });
        }
    }
}
