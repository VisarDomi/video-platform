// src/config.ts
import "dotenv/config";
import * as fs from "fs";
import logger from "./logger.js";

// --- Read Environment Variables ---
const videoDownloadRaw = process.env.VIDEO_DOWNLOAD;
const videoConvertRaw = process.env.VIDEO_CONVERT;
const videoModifiedRaw = process.env.VIDEO_MODIFIED;
const frontendDistRaw = process.env.FRONTEND_DIST_PATH;
// WHY THE CHANGE: Read the new trash path from the environment variables.
const videoTrashRaw = process.env.VIDEO_TRASH_PATH;

// --- Runtime Validation ---
// WHY: We check the raw values here. If any are missing, we exit.
// TypeScript knows that if the code continues past this block, the variables cannot be undefined.
if (!videoDownloadRaw || !videoConvertRaw || !videoModifiedRaw || !videoTrashRaw) {
    logger.error("FATAL ERROR: VIDEO_DOWNLOAD, VIDEO_CONVERT, VIDEO_MODIFIED, and VIDEO_TRASH_PATH must all be set in the .env file.");
    process.exit(1);
}

if (!frontendDistRaw) {
    logger.error("FATAL ERROR: FRONTEND_DIST_PATH must be set in the .env file.");
    process.exit(1);
}

// --- Export Guaranteed Constants ---
export const VIDEO_DOWNLOAD_PATH: string = videoDownloadRaw;
export const VIDEO_CONVERT_PATH: string = videoConvertRaw;
export const VIDEO_MODIFIED_PATH: string = videoModifiedRaw;
export const FRONTEND_DIST_PATH: string = frontendDistRaw;
// WHY THE CHANGE: Export the validated trash path for use in other services.
export const VIDEO_TRASH_PATH: string = videoTrashRaw;

// --- Path Constants ---
export const ALL_VIDEO_PATHS = [
    { path: VIDEO_DOWNLOAD_PATH, type: "original" as const },
    { path: VIDEO_CONVERT_PATH, type: "edited" as const },
    { path: VIDEO_MODIFIED_PATH, type: "edited" as const },
];
export const PORT = 7973;

// --- Startup Validation ---
// WHY THE CHANGE: Add the new trash path to the list of directories to validate on startup.
[VIDEO_DOWNLOAD_PATH, VIDEO_CONVERT_PATH, VIDEO_MODIFIED_PATH, VIDEO_TRASH_PATH].forEach((dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir);
        logger.info(`created: ${dir}`);
    }
    try {
        fs.accessSync(dir, fs.constants.R_OK);
    } catch (err) {
        logger.error(`The configured video directory is not readable: ${dir}`);
        process.exit(1);
    }
});

// Validate frontend path
if (!fs.existsSync(FRONTEND_DIST_PATH)) {
    logger.error(`The configured frontend dist path does not exist: ${FRONTEND_DIST_PATH}`);
    process.exit(1);
}
