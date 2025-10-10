// src/config.ts
import "dotenv/config";
import * as fs from "fs";
import logger from "./logger.js";

// --- Read Environment Variables ---
const videoDownloadRaw = process.env.VIDEO_DOWNLOAD;
const videoConvertRaw = process.env.VIDEO_CONVERT;
const videoModifiedRaw = process.env.VIDEO_MODIFIED;
const frontendDistRaw = process.env.FRONTEND_DIST_PATH;

// --- Runtime Validation ---
// WHY: We check the raw values here. If any are missing, we exit.
// TypeScript knows that if the code continues past this block, the variables cannot be undefined.
if (!videoDownloadRaw || !videoConvertRaw || !videoModifiedRaw) {
    logger.error("FATAL ERROR: VIDEO_DOWNLOAD, VIDEO_CONVERT, and VIDEO_MODIFIED must all be set in the .env file.");
    process.exit(1);
}

if (!frontendDistRaw) {
    logger.error("FATAL ERROR: FRONTEND_DIST_PATH must be set in the .env file.");
    process.exit(1);
}

// --- Export Guaranteed Constants ---
// WHY: Because of the check above, TypeScript can correctly infer the type of these constants as 'string', not 'string | undefined'.
// This solves the errors in all other files that import them.
export const VIDEO_DOWNLOAD_PATH: string = videoDownloadRaw;
export const VIDEO_CONVERT_PATH: string = videoConvertRaw;
export const VIDEO_MODIFIED_PATH: string = videoModifiedRaw;
export const FRONTEND_DIST_PATH: string = frontendDistRaw;

// --- Path Constants ---
export const ALL_VIDEO_PATHS = [
    { path: VIDEO_DOWNLOAD_PATH, type: "original" as const },
    { path: VIDEO_CONVERT_PATH, type: "edited" as const },
    { path: VIDEO_MODIFIED_PATH, type: "edited" as const },
];
export const PORT = 7973;

// --- Startup Validation ---
[VIDEO_DOWNLOAD_PATH, VIDEO_CONVERT_PATH, VIDEO_MODIFIED_PATH].forEach((dir) => {
    if (!fs.existsSync(dir)) {
        logger.error(`The configured video directory does not exist: ${dir}`);
        process.exit(1);
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
