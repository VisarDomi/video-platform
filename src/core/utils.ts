import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { VIDEO_DOWNLOADER_PATH, VIDEO_EDITED_PATH, VIDEO_CONVERTED_PATH, LIVE_STATUS_PATH } from "./config.js";
import { FileNotFoundError } from "./errors.js";
import logger from "./logger.js";
import * as types from "./types.js";
import * as constants from "./constants.js";
import url from "url";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export function findProjectRoot(): string {
    let currentDir = __dirname;
    while (true) {
        const packageJsonPath = path.join(currentDir, constants.FILE_NAMES.PACKAGE_JSON);
        if (fs.existsSync(packageJsonPath)) {
            return currentDir;
        }

        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) {
            throw new Error(`Could not find project root containing ${constants.FILE_NAMES.PACKAGE_JSON}`);
        }
        currentDir = parentDir;
    }
}

export async function findVideoPath(filename: string): Promise<string> {
    let finalPath = null;
    try {
        const fullPath = path.join(VIDEO_DOWNLOADER_PATH, filename);
        await fsPromises.access(fullPath);
        finalPath = fullPath;
    } catch {}
    try {
        const convertPath = path.join(VIDEO_EDITED_PATH, filename);
        await fsPromises.access(convertPath);
        finalPath = convertPath;
    } catch {}
    try {
        const modifiedPath = path.join(VIDEO_CONVERTED_PATH, filename);
        await fsPromises.access(modifiedPath);
        finalPath = modifiedPath;
    } catch {}
    if (finalPath === null) {
        throw new FileNotFoundError(`Video not found: ${filename}`);
    }
    return finalPath;
}

export async function getLiveFolders(): Promise<Set<string>> {
    try {
        const content = await fsPromises.readFile(LIVE_STATUS_PATH, constants.MISC.ENCODING_UTF8);
        const liveData: types.LiveStatus = JSON.parse(content);

        if (liveData && Array.isArray(liveData.downloads)) {
            const liveFolderNames = liveData.downloads
                .map((download) => {
                    if (typeof download.segmentsDirPath === constants.MISC.JS_TYPES.STRING) {
                        return path.basename(download.segmentsDirPath);
                    }
                    return null;
                })
                .filter((name): name is string => name !== null);

            return new Set(liveFolderNames);
        }

        logger.warn(`${LIVE_STATUS_PATH} does not contain a valid 'downloads' array, ignoring.`);
        return new Set();
    } catch (error: any) {
        if (error.code !== constants.MISC.ERROR_CODE.ENOENT) {
            logger.error(`Failed to read or parse ${LIVE_STATUS_PATH}`, { error });
        }
        return new Set();
    }
}
