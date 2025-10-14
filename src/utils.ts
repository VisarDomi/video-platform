// src/common/utils.ts
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { VIDEO_DOWNLOAD_PATH, VIDEO_CONVERT_PATH, VIDEO_MODIFIED_PATH } from "./config.js";
import { FileNotFoundError } from "./errors.js";

/**
 * Finds the project root by searching upwards from the given directory for a package.json file.
 * @param {string} startDir - The directory to start the search from. Defaults to the directory of the current module.
 * @returns {string} The absolute path to the project root.
 * @throws {Error} If package.json is not found.
 */
export function findProjectRoot(startDir: string): string {
    let currentDir = startDir;
    while (true) {
        const packageJsonPath = path.join(currentDir, "package.json");
        if (fs.existsSync(packageJsonPath)) {
            return currentDir;
        }

        const parentDir = path.dirname(currentDir);
        // If we've reached the file system root and haven't found it
        if (parentDir === currentDir) {
            throw new Error("Could not find project root containing a package.json.");
        }
        currentDir = parentDir;
    }
}

export async function findVideoPath(folderName: string): Promise<string> {
    let finalPath = null;
    try {
        const fullPath = path.join(VIDEO_DOWNLOAD_PATH, folderName);
        await fsPromises.access(fullPath);
        finalPath = fullPath;
    } catch {}
    try {
        const convertPath = path.join(VIDEO_CONVERT_PATH, folderName);
        await fsPromises.access(convertPath);
        finalPath = convertPath;
    } catch {}
    try {
        const modifiedPath = path.join(VIDEO_MODIFIED_PATH, folderName);
        await fsPromises.access(modifiedPath);
        finalPath = modifiedPath;
    } catch {}
    if (finalPath === null) {
        throw new FileNotFoundError(`Video not found: ${folderName}`);
    }
    return finalPath;
}
