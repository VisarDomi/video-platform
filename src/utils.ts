// src/utils.ts
import * as path from 'path';
import * as url from 'url';
import * as fsPromises from 'fs/promises';
import * as fs from 'fs';

import * as config from './config.js';
import logger from './logger.js';
import * as state from './state.js';
import * as requests from './requests.js';
import { AuthContext } from './auth/authContext.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const getStatusFilePath = () => path.resolve(__dirname, '..', config.getConfig().fileNames.liveStatus);
const FOLDER_NAME_REGEX = /^(\d{4}-\d{2}-\d{2} \d{6}) (.+)$/;

export async function updateStatusFile(authContext: AuthContext) {
    try {
        const activeDownloads = Array.from(state.getActiveDownloads().entries()).map(([masterPlaylistUrl, downloadInfo]) => ({
            masterPlaylistUrl,
            ...downloadInfo
        }));

        const status = {
            activeDownloads,
            tokens: {
                tt: authContext.getTt(),
                ttu: authContext.getTtu(),
                tte: authContext.getTte(),
                st: authContext.getTangoST(),
            },
            lastUpdated: new Date().toISOString(),
        };
        await fsPromises.writeFile(getStatusFilePath(), JSON.stringify(status, null, 2));
    } catch (error) {
        logger.error('Failed to write status file', { error });
    }
}

export async function getLiveUrlFromMaster(masterPlaylistUrl: string, authContext: AuthContext): Promise<string | null> {
    try {
        const masterListBody = await requests.getMasterList(masterPlaylistUrl, authContext);
        if (!masterListBody) {
            logger.warn(`Could not fetch master playlist body from: ${masterPlaylistUrl}`);
            return null;
        }

        const masterLines = getResponseBodyLines(masterListBody);
        let relativeLiveUrl;
        for (let i = 0; i < masterLines.length; i++) {
            if (masterLines[i].includes("RESOLUTION=1280x720")) {
                relativeLiveUrl = masterLines[i + 1];
                break;
            }
        }

        if (!relativeLiveUrl) {
            logger.warn(`Could not find HD stream in master playlist: ${masterPlaylistUrl}`);
            return null;
        }

        const cinemaApiUrl = masterPlaylistUrl.split("/v2/")[0];
        let livePlaylistUrl = `${cinemaApiUrl}${relativeLiveUrl}`;
        if (livePlaylistUrl.endsWith("&")) {
            livePlaylistUrl = livePlaylistUrl.substring(0, livePlaylistUrl.length - 1);
        }
        return livePlaylistUrl;
    } catch (error) {
        logger.error(`Error resolving live URL from master: ${masterPlaylistUrl}`, { error });
        return null;
    }
}

export function getFormattedDate(date: Date = new Date()): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}${minutes}${seconds}`;
}

/**
 * Generates a standardized folder/file name for a download.
 */
export function generateDownloadBaseName(alias: string, date: Date): string {
    const formattedDate = getFormattedDate(date);
    return `${formattedDate} ${alias}`;
}

/**
 * Parses a download folder name into its constituent parts.
 */
export function parseDownloadFolderName(folderName: string): { alias: string; dateString: string } | null {
    const match = folderName.match(FOLDER_NAME_REGEX);
    if (!match) {
        return null;
    }
    return {
        dateString: match[1],
        alias: match[2],
    };
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

export function getResponseBodyLines(responseBody: string) {
    return responseBody.split("\n");
}

export async function moveToTrash(sourcePath: string) {
    const storagePath = config.getConfig().storagePath;
    const trashDir = path.join(storagePath, 'trash');

    try {
        await fsPromises.stat(sourcePath);
    } catch (error: any) {
        if (error.code === 'ENOENT') {
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
        if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') {
            try {
                const baseName = path.basename(sourcePath);
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
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