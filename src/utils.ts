// src/utils.ts
import * as path from 'path';
import * as url from 'url';
import * as fsPromises from 'fs/promises';
import * as fs from 'fs';

import * as config from './config.js';
import logger from './logger.js';
import * as state from './state.js';
import * as requests from './requests.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const getSessionFilePath = () => path.resolve(__dirname, '..', config.getConfig().fileNames.session);
const getStatusFilePath = () => path.resolve(__dirname, '..', config.getConfig().fileNames.liveStatus);

export async function saveTokenToFile() {
    try {
        const tangoRT = state.getTangoRT();
        if (tangoRT) {
            await fsPromises.writeFile(getSessionFilePath(), JSON.stringify({ tangoRT }, null, 2));
            logger.info(`Session token (Tango-RT) saved to ${config.getConfig().fileNames.session}`);
        }
    } catch (error) {
        logger.error('Failed to save session file', { error });
    }
}

export async function loadTokenFromFile(): Promise<boolean> {
    try {
        const data = await fsPromises.readFile(getSessionFilePath(), 'utf-8');
        const session = JSON.parse(data);
        if (session.tangoRT) {
            state.setTangoRT(session.tangoRT);
            return true;
        }
    } catch (error: any) {
        if (error.code !== 'ENOENT') { // Don't log an error if the file simply doesn't exist
            logger.error('Failed to read session file', { error });
        }
    }
    return false;
}

/**
 * Writes the current download and authentication state to a file for the web server to read.
 */
export async function updateStatusFile() {
    try {
        // Convert Map to a more JSON-friendly format
        const activeDownloads = Array.from(state.getActiveDownloads().entries()).map(([masterPlaylistUrl, downloadInfo]) => ({
            masterPlaylistUrl,
            ...downloadInfo
        }));

        const status = {
            activeDownloads, // Replaces downloads, downloading, and aliases
            tokens: {
                tt: state.getTt(),
                ttu: state.getTtu(),
                tte: state.getTte(),
                st: state.getTangoST(),
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
export async function getLiveUrlFromMaster(masterPlaylistUrl: string): Promise<string | null> {
    try {
        const masterListBody = await requests.getMasterList(masterPlaylistUrl);
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
// --- END NEW SHARED FUNCTION ---


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
    tsFilePath: string; // <-- RE-ADDED
    segmentsDirPath: string;
}

export function createPaths(streamer: string, formattedDate: string): RawPaths {
    const baseFilename = `${formattedDate} ${streamer}`;
    const storageLocation = config.getConfig().storagePath;

    // Ensure the main storage directory exists
    if (!fs.existsSync(storageLocation)) {
        fs.mkdirSync(storageLocation, { recursive: true });
        logger.info(`Storage folder created at: ${storageLocation}`);
    }

    const tsFilePath = path.resolve(storageLocation, `${baseFilename}.ts`); // <-- RE-ADDED
    const segmentsDirPath = path.resolve(storageLocation, baseFilename);
    
    // Ensure the specific directory for this download's segments exists
    if (!fs.existsSync(segmentsDirPath)) {
        fs.mkdirSync(segmentsDirPath, { recursive: true });
    }

    return { tsFilePath, segmentsDirPath }; // <-- RE-ADDED tsFilePath
}

export function createCookie() {
    const tt = state.getTt();
    const ttu = state.getTtu();
    const tte = state.getTte();
    if (!(tt && ttu && tte)) {
        throw new Error("tt, ttu, tte not found")
    }
    return `tt=${tt};ttu=${ttu};tte=${tte}`
}

export function createCookieST() {
    const tangoST = state.getTangoST();
    if (!tangoST) {
        throw new Error("Tango-ST not found")
    }
    return `Tango-ST=${tangoST}`
}

export function createCookieRT() {
    const tangoRT = state.getTangoRT();
    if (!tangoRT) {
        throw new Error("Tango-RT not found")
    }
    return `Tango-RT=${tangoRT}`
}

export function getResponseBodyLines(responseBody: string) {
    return responseBody.split("\n");
}