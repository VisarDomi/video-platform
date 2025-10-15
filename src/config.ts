// src/config.ts
import * as fs from "fs";
import * as path from "path";
import * as url from "url";
import * as os from "os";
import * as utils from "./utils.js";
import logger from "./logger.js";

// --- Correct Path Resolution ---
const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = utils.findProjectRoot(__dirname);
const ROOT_CONFIG_PATH = path.resolve(projectRoot, "config.json");

interface IConfig {
    videoPaths: {
        download: string;
        convert: string;
        modified: string;
        trash: string;
    };
    frontendDistPath: string;
    sharedStatePath: string;
    cachePath: string;
}

const defaultConfig: Omit<IConfig, "cachePath"> = {
    videoPaths: {
        download: path.join(os.homedir(), "Videos", "tango", "download"),
        convert: path.join(os.homedir(), "Videos", "tango", "convert"),
        modified: path.join(os.homedir(), "Videos", "tango", "modified"),
        trash: path.join(os.homedir(), "Videos", "tango", "trash"),
    },
    frontendDistPath: "/home/visar/Documents/tango-repos/video-editor-frontend/dist",
    sharedStatePath: path.join(os.homedir(), ".local", "share", "tango-services"),
};

function loadConfig(): IConfig {
    let mergedConfig = { ...defaultConfig };

    if (fs.existsSync(ROOT_CONFIG_PATH)) {
        try {
            const fileContent = fs.readFileSync(ROOT_CONFIG_PATH, "utf-8");
            const userConfig = JSON.parse(fileContent);

            mergedConfig = {
                ...mergedConfig,
                ...userConfig,
                videoPaths: { ...mergedConfig.videoPaths, ...userConfig.videoPaths },
            };
        } catch (error) {
            logger.error(`Error reading or parsing config file at ${ROOT_CONFIG_PATH}. Using defaults.`, { error });
            mergedConfig = { ...defaultConfig };
        }
    } else {
        logger.warn(`config.json not found at ${ROOT_CONFIG_PATH}. Using default configuration.`);
    }

    const cachePath = path.join(mergedConfig.sharedStatePath, "tango");

    return { ...mergedConfig, cachePath } as IConfig;
}

const config = loadConfig();

// --- Startup Validation ---
if (!config.frontendDistPath) {
    logger.error(`FATAL ERROR: frontendDistPath must be set in config.json.`);
    process.exit(1);
}

const pathsToValidate = [config.videoPaths.download, config.videoPaths.convert, config.videoPaths.modified, config.videoPaths.trash, config.frontendDistPath];

pathsToValidate.forEach((dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        logger.info(`Created directory: ${dir}`);
    }
    try {
        fs.accessSync(dir, fs.constants.R_OK);
    } catch (err) {
        logger.error(`The configured directory is not readable or does not exist: ${dir}`);
        process.exit(1);
    }
});

// Ensure shared state and cache paths exist
[config.sharedStatePath, config.cachePath].forEach((dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        logger.info(`Created directory: ${dir}`);
    }
});

// --- Export Guaranteed Constants ---
export const VIDEO_DOWNLOAD_PATH: string = config.videoPaths.download;
export const VIDEO_CONVERT_PATH: string = config.videoPaths.convert;
export const VIDEO_MODIFIED_PATH: string = config.videoPaths.modified;
export const VIDEO_TRASH_PATH: string = config.videoPaths.trash;
export const FRONTEND_DIST_PATH: string = config.frontendDistPath;
export const CACHE_PATH: string = config.cachePath;
export const DB_PATH: string = path.join(CACHE_PATH, "durations.sqlite");
export const LIVE_STATUS_PATH: string = path.join(config.sharedStatePath, "live-status.json");

// --- Path Constants ---
export const ALL_VIDEO_PATHS = [
    { path: VIDEO_DOWNLOAD_PATH, type: "original" as const },
    { path: VIDEO_CONVERT_PATH, type: "edited" as const },
    { path: VIDEO_MODIFIED_PATH, type: "edited" as const },
];

export const PORT = 7973;
