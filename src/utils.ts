// src/utils.ts
import * as path from 'path';
import * as url from 'url';
import * as fsPromises from 'fs/promises';
import * as fs from 'fs';

import * as config from './config.js';
import logger from './logger.js';
import * as state from './state.js';
import * as requests from './requests.js';
import { AuthContext } from './authContext.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const getStatusFilePath = () => path.resolve(__dirname, '..', config.getConfig().fileNames.liveStatus);

/**
 * Writes the current download and authentication state to a file for the web server to read.
 */
export async function updateStatusFile(authContext: AuthContext) {
    try {
        // Convert Map to a more JSON-friendly format
        const activeDownloads = Array.from(state.getActiveDownloads().entries()).map(([masterPlaylistUrl, downloadInfo]) => ({
            masterPlaylistUrl,
            ...downloadInfo
        }));

        const status = {
            activeDownloads, // Replaces downloads, downloading, and aliases
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

/**
 * Fetches and parses a master playlist URL to find the final live playlist URL for the HD stream.
 * @param masterPlaylistUrl The URL of the master m3u8 playlist.
 * @returns The final live m3u8 playlist URL, or null if it cannot be resolved.
 */
export async function getLiveUrlFromMaster(masterPlaylistUrl: string, authContext: AuthContext): Promise<string | null> {
    try {
        const masterListBody = await requests.getMasterList(masterPlaylistUrl, authContext);
        if (!masterListBody) {
            logger.warn(`Could not fetch master playlist body from: ${masterPlaylistUrl}`);
            return null;
        }

        const masterLines = getResponseBodyLines(masterListBody); // Use local helper
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


export function getFormattedDate() {
    const now = new Date(Date.now());
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const seconds = String(now.getSeconds()).padStart(2, "0");
    const formattedDate = `${year}-${month}-${day} ${hours}${minutes}${seconds}`;

    return formattedDate;
}

export interface RawPaths {
    tsFilePath: string;
    segmentsDirPath: string;
}

export function createPaths(streamer: string, formattedDate: string): RawPaths {
    const baseFilename = `${formattedDate} ${streamer}`;
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

export function createCookie(authContext: AuthContext) {
    const tt = authContext.getTt();
    const ttu = authContext.getTtu();
    const tte = authContext.getTte();
    if (!(tt && ttu && tte)) {
        throw new Error("tt, ttu, tte not found in AuthContext")
    }
    return `tt=${tt};ttu=${ttu};tte=${tte}`
}

export function createCookieST(authContext: AuthContext) {
    const tangoST = authContext.getTangoST();
    if (!tangoST) {
        throw new Error("Tango-ST not found in AuthContext")
    }
    return `Tango-ST=${tangoST}`
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