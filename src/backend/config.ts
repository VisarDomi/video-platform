import "dotenv/config";
import * as fs from "fs";
import logger from "./logger.js";

// --- Environment Variable Validation ---
const VIDEOS_DIRS_RAW = process.env.VIDEOS_DIRS;
export const FRONTEND_DIST_PATH = process.env.FRONTEND_DIST_PATH;

if (!VIDEOS_DIRS_RAW) {
    logger.error("FATAL ERROR: VIDEOS_DIRS must be set in the .env file as a comma-separated list of paths.");
    process.exit(1);
}

if (!FRONTEND_DIST_PATH) {
    logger.error("FATAL ERROR: FRONTEND_DIST_PATH must be set in the .env file.");
    process.exit(1);
}

// --- Path Constants ---
/**
 * An array of absolute paths to the root directories containing original videos.
 * An 'edited' subdirectory will be created inside each of these.
 */
export const VIDEO_ROOT_DIRS = VIDEOS_DIRS_RAW.split(",").map((p) => p.trim());
export const PORT = 7998;

// --- Startup Validation ---
VIDEO_ROOT_DIRS.forEach((dir) => {
    if (!fs.existsSync(dir)) {
        logger.error(`The configured video directory does not exist. Skipping... ${dir}`);
        return;
    }
    try {
        fs.accessSync(dir, fs.constants.R_OK);
    } catch (err) {
        logger.error(`The configured video directory is not readable. Skipping... ${dir}`);
        return;
    }
});

// Validate frontend path
if (!fs.existsSync(FRONTEND_DIST_PATH)) {
    logger.error(`The configured frontend dist path does not exist: ${FRONTEND_DIST_PATH}`);
    process.exit(1);
}
