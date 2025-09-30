// src/combiner/fileTracker.ts
import * as fsPromises from "fs/promises";
import * as path from "path";
import * as url from "url";

import * as utils from "../common/utils.js";

// --- Correct Path Resolution ---
const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = utils.findProjectRoot(__dirname)
const PROCESSED_FILE_PATH = path.join(projectRoot, "processed-by-combiner.txt");

/**
 * Reads the processed-by-combiner.txt file and returns a Set of filenames.
 * Returns an empty set if the file doesn't exist.
 */
export async function loadProcessedFiles(): Promise<Set<string>> {
    try {
        const content = await fsPromises.readFile(PROCESSED_FILE_PATH, "utf-8");
        const titles = content.split("\n").filter((line) => line.trim() !== "");
        return new Set(titles);
    } catch (error: any) {
        if (error.code === "ENOENT") {
            return new Set();
        }
        throw error;
    }
}

/**
 * Appends successfully processed/combined filenames to the tracking file.
 */
export async function saveProcessedFiles(fileNames: string[]): Promise<void> {
    if (fileNames.length === 0) return;
    const content = fileNames.join("\n") + "\n";
    await fsPromises.appendFile(PROCESSED_FILE_PATH, content);
}

/**
 * Reads all .mp4 files from the specified directory.
 */
export async function getLocalVideoFiles(directory: string): Promise<string[]> {
    const allFiles = await fsPromises.readdir(directory);
    return allFiles.filter((file) => file.toLowerCase().endsWith(".mp4"));
}
