import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { getAllSearchPaths, LIVE_STATUS_PATH } from "./config.js";
import { FileNotFoundError } from "./errors.js";
import logger from "./logger.js";
import * as types from "./types.js";
import * as constants from "./constants.js";
import url from "url";

export function findProjectRoot(): string {
    const __filename = url.fileURLToPath(import.meta.url);
    let currentDir = path.dirname(__filename);
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
    const searchPaths = getAllSearchPaths();

    for (const { path: basePath } of searchPaths) {
        try {
            const fullPath = path.join(basePath, filename);
            await fsPromises.access(fullPath);
            return fullPath;
        } catch {}
    }

    throw new FileNotFoundError(`Video not found: ${filename}`);
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

