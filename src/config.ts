import * as fs from "fs";
import * as path from "path";
import * as url from "url";
import * as os from "os";
import * as utils from "./utils.js";
import logger from "./logger.js";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = utils.findProjectRoot(__dirname);
const ROOT_CONFIG_PATH = path.resolve(projectRoot, "config.json");

interface IConfig {
    videoPaths: {
        downloads: string;
        edited: string;
        converted: string;
        trash: string;
    };
    frontendDistPath: string;
    sharedStatePath: string;
    cachePath: string;
}

const defaultConfig: Omit<IConfig, "cachePath"> = {
    videoPaths: {
        downloads: path.join(os.homedir(), "Videos", "downloads"),
        edited: path.join(os.homedir(), "Videos", "editor", "edited"),
        converted: path.join(os.homedir(), "Videos", "converter", "converted"),
        trash: path.join(os.homedir(), "Videos", "editor", "trash"),
    },
    frontendDistPath: "/home/visar/Documents/tango-repos/video-editor-frontend/dist",
    sharedStatePath: path.join(os.homedir(), ".local", "share", "video-services"),
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

    const cachePath = path.join(mergedConfig.sharedStatePath, "cache");

    return { ...mergedConfig, cachePath } as IConfig;
}

const config = loadConfig();

if (!config.frontendDistPath) {
    logger.error(`FATAL ERROR: frontendDistPath must be set in config.json.`);
    process.exit(1);
}

const pathsToValidate = [config.videoPaths.downloads, config.videoPaths.edited, config.videoPaths.converted, config.videoPaths.trash, config.frontendDistPath];

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

[config.sharedStatePath, config.cachePath].forEach((dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        logger.info(`Created directory: ${dir}`);
    }
});

export const VIDEO_DOWNLOADS_PATH: string = config.videoPaths.downloads;
export const VIDEO_EDITED_PATH: string = config.videoPaths.edited;
export const VIDEO_CONVERTED_PATH: string = config.videoPaths.converted;
export const VIDEO_TRASH_PATH: string = config.videoPaths.trash;
export const FRONTEND_DIST_PATH: string = config.frontendDistPath;
export const CACHE_PATH: string = config.cachePath;
export const DB_PATH: string = path.join(CACHE_PATH, "tango.sqlite");
export const LIVE_STATUS_PATH: string = path.join(config.sharedStatePath, "live-status.json");

export const ALL_VIDEO_PATHS = [
    { path: VIDEO_DOWNLOADS_PATH, type: "original" as const },
    { path: VIDEO_EDITED_PATH, type: "edited" as const },
    { path: VIDEO_CONVERTED_PATH, type: "edited" as const },
];

export const PORT = 7973;
