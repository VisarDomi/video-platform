import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { VIDEO_DOWNLOAD_PATH, VIDEO_CONVERT_PATH, VIDEO_MODIFIED_PATH, LIVE_STATUS_PATH } from "./config.js";
import { FileNotFoundError } from "./errors.js";
import logger from "./logger.js";
import * as types from "./types.js";

export function findProjectRoot(startDir: string): string {
    let currentDir = startDir;
    while (true) {
        const packageJsonPath = path.join(currentDir, "package.json");
        if (fs.existsSync(packageJsonPath)) {
            return currentDir;
        }

        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) {
            throw new Error("Could not find project root containing a package.json.");
        }
        currentDir = parentDir;
    }
}

export async function findVideoPath(filename: string): Promise<string> {
    let finalPath = null;
    try {
        const fullPath = path.join(VIDEO_DOWNLOAD_PATH, filename);
        await fsPromises.access(fullPath);
        finalPath = fullPath;
    } catch {}
    try {
        const convertPath = path.join(VIDEO_CONVERT_PATH, filename);
        await fsPromises.access(convertPath);
        finalPath = convertPath;
    } catch {}
    try {
        const modifiedPath = path.join(VIDEO_MODIFIED_PATH, filename);
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
        const content = await fsPromises.readFile(LIVE_STATUS_PATH, "utf-8");
        const liveData: types.LiveStatus = JSON.parse(content);

        if (liveData && Array.isArray(liveData.downloads)) {
            const liveFolderNames = liveData.downloads
                .map((download) => {
                    if (typeof download.segmentsDirPath === "string") {
                        return path.basename(download.segmentsDirPath);
                    }
                    return null;
                })
                .filter((name): name is string => name !== null);

            return new Set(liveFolderNames);
        }

        logger.warn("live-status.json does not contain a valid 'downloads' array, ignoring.");
        return new Set();
    } catch (error: any) {
        if (error.code !== "ENOENT") {
            logger.error("Failed to read or parse live-status.json", { error });
        }
        return new Set();
    }
}
