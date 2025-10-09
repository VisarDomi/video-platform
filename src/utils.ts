import { promises as fsPromises } from "fs";
import path from "path";
import { VIDEO_ROOT_DIRS } from "./config.js";

/**
 * Searches all configured directories to find the full path of a given video file.
 * Returns the full path and the base directory it was found in.
 * @param type The type of video ('original' or 'edited').
 * @param filename The name of the video file.
 * @returns {Promise<{fullPath: string, baseDir: string} | null>} An object with the full path and base directory, or null if not found.
 */
export async function findVideoPath(type: "original" | "edited", filename: string): Promise<{ fullPath: string; baseDir: string } | null> {
    for (const baseDir of VIDEO_ROOT_DIRS) {
        const searchDir = type === "original" ? baseDir : path.join(baseDir, "edited");
        const fullPath = path.join(searchDir, filename);
        try {
            await fsPromises.stat(fullPath);
            return { fullPath, baseDir }; // Found it
        } catch (e) {
            // Not found, continue to next directory
        }
    }
    return null; // Not found in any directory
}
