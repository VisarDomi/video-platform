import 'dotenv/config';

// --- Environment Variable Validation ---
const VIDEOS_DIRS_RAW = process.env.VIDEOS_DIRS;

if (!VIDEOS_DIRS_RAW) {
    console.error("FATAL ERROR: VIDEOS_DIRS must be set in the .env file as a comma-separated list of paths.");
    process.exit(1);
}

// --- Path Constants ---
/**
 * An array of absolute paths to the root directories containing original videos.
 * An 'edited' subdirectory will be created inside each of these.
 */
export const VIDEO_ROOT_DIRS = VIDEOS_DIRS_RAW.split(',').map(p => p.trim());
export const PORT = 7998;