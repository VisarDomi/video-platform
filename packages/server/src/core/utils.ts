import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { getProviderPaths } from "./config.js";
import { FileNotFoundError } from "./errors.js";
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

export async function resolveVideo(filename: string, provider: string): Promise<types.VideoRef> {
    const paths = getProviderPaths(provider);
    const searchPaths = [
        { path: path.join(paths.downloader, ".active"), type: constants.ALL_VIDEO_PATHS_TYPES.ORIGINAL },
        { path: paths.downloader, type: constants.ALL_VIDEO_PATHS_TYPES.ORIGINAL },
        { path: paths.edited, type: constants.ALL_VIDEO_PATHS_TYPES.EDITED },
    ];

    for (const { path: basePath, type } of searchPaths) {
        try {
            const fullPath = path.join(basePath, filename);
            await fsPromises.access(fullPath);
            return { filename, provider, type, dirPath: fullPath };
        } catch {}
    }

    throw new FileNotFoundError(`Video not found: ${filename} (provider=${provider})`);
}
