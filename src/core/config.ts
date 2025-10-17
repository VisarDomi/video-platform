import * as fs from "fs";
import * as path from "path";
import * as url from "url";
import * as os from "os";
import * as utils from "./utils.js";
import logger from "./logger.js";
import * as constants from "./constants.js";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = utils.findProjectRoot(__dirname);
const ROOT_CONFIG_PATH = path.resolve(projectRoot, constants.FILE_NAMES.CONFIG);

interface IConfig {
    videoPaths: {
        downloader: string;
        edited: string;
        trash: string;
        converted: string;
    };
    frontendDistPath: string;
    sharedStatePath: string;
    cachePath: string;
}

const defaultConfig: Omit<IConfig, typeof constants.CONFIG_KEYS.CACHE_PATH> = {
    videoPaths: {
        downloader: path.join(
            os.homedir(),
            constants.DEFAULT_PATHS.HOME_VIDEOS,
            constants.DEFAULT_PATHS.DOWNLOADS,
            constants.DEFAULT_PATHS.TANGO,
            constants.DEFAULT_PATHS.DOWNLOADER
        ),
        edited: path.join(
            os.homedir(),
            constants.DEFAULT_PATHS.HOME_VIDEOS,
            constants.DEFAULT_PATHS.DOWNLOADS,
            constants.DEFAULT_PATHS.TANGO,
            constants.DEFAULT_PATHS.EDITOR,
            constants.DEFAULT_PATHS.EDITED
        ),
        trash: path.join(
            os.homedir(),
            constants.DEFAULT_PATHS.HOME_VIDEOS,
            constants.DEFAULT_PATHS.DOWNLOADS,
            constants.DEFAULT_PATHS.TANGO,
            constants.DEFAULT_PATHS.EDITOR,
            constants.DEFAULT_PATHS.TRASH
        ),
        converted: path.join(
            os.homedir(),
            constants.DEFAULT_PATHS.HOME_VIDEOS,
            constants.DEFAULT_PATHS.DOWNLOADS,
            constants.DEFAULT_PATHS.TANGO,
            constants.DEFAULT_PATHS.CONVERTER,
            constants.DEFAULT_PATHS.CONVERTED
        ),
    },
    frontendDistPath: constants.MISC.EMPTY_STRING,
    sharedStatePath: path.join(os.homedir(), constants.DIRECTORIES.SHARED_STATE_BASE),
};

function loadConfig(): IConfig {
    let mergedConfig = { ...defaultConfig };

    if (fs.existsSync(ROOT_CONFIG_PATH)) {
        try {
            const fileContent = fs.readFileSync(ROOT_CONFIG_PATH, constants.MISC.ENCODING_UTF8);
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
        logger.warn(`${constants.FILE_NAMES.CONFIG} not found at ${ROOT_CONFIG_PATH}. Using default configuration.`);
    }

    const cachePath = path.join(mergedConfig.sharedStatePath, constants.DIRECTORIES.CACHE);

    return { ...mergedConfig, cachePath } as IConfig;
}

const config = loadConfig();

if (!config.frontendDistPath) {
    logger.error(`FATAL ERROR: frontendDistPath must be set in ${constants.FILE_NAMES.CONFIG}.`);
    process.exit(1);
}

const pathsToValidate = [config.videoPaths.downloader, config.videoPaths.edited, config.videoPaths.converted, config.videoPaths.trash, config.frontendDistPath];

pathsToValidate.forEach((dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
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
    }
});

export const VIDEO_DOWNLOADER_PATH: string = config.videoPaths.downloader;
export const VIDEO_EDITED_PATH: string = config.videoPaths.edited;
export const VIDEO_CONVERTED_PATH: string = config.videoPaths.converted;
export const VIDEO_TRASH_PATH: string = config.videoPaths.trash;
export const FRONTEND_DIST_PATH: string = config.frontendDistPath;
export const CACHE_PATH: string = config.cachePath;
export const DB_PATH: string = path.join(CACHE_PATH, constants.FILE_NAMES.SQLITE_DB);
export const LIVE_STATUS_PATH: string = path.join(config.sharedStatePath, constants.FILE_NAMES.LIVE_STATUS);

export const ALL_VIDEO_PATHS = [
    { path: VIDEO_DOWNLOADER_PATH, type: constants.ALL_VIDEO_PATHS_TYPES.ORIGINAL },
    { path: VIDEO_EDITED_PATH, type: constants.ALL_VIDEO_PATHS_TYPES.EDITED },
    { path: VIDEO_CONVERTED_PATH, type: constants.ALL_VIDEO_PATHS_TYPES.EDITED },
];

export const PORT = constants.API.PORT;
