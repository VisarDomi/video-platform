import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as utils from "./utils.js";
import * as constants from "./constants.js";

const projectRoot = utils.findProjectRoot();

interface PathConfig {
    downloader: string;
    edited: string;
    trash: string;
}

interface IConfig {
    providers: Record<string, PathConfig>;
    frontendDistPath: string;
    sharedStatePath: string;
    fc2FilePath: string;
    scFilePath: string;
    tangoFilePath: string;
}

const DEFAULT_PROVIDERS = ["tango", "fc2", "sc"];

function generateDefaultPaths(providerName: string): PathConfig {
    return {
        downloader: path.join(
            os.homedir(),
            constants.DEFAULT_PATHS.HOME_VIDEOS,
            constants.DEFAULT_PATHS.DOWNLOADS,
            providerName,
            constants.DEFAULT_PATHS.DOWNLOADER
        ),
        edited: path.join(
            os.homedir(),
            constants.DEFAULT_PATHS.HOME_VIDEOS,
            constants.DEFAULT_PATHS.DOWNLOADS,
            providerName,
            constants.DEFAULT_PATHS.EDITOR,
            constants.DEFAULT_PATHS.EDITED
        ),
        trash: path.join(
            os.homedir(),
            constants.DEFAULT_PATHS.HOME_VIDEOS,
            constants.DEFAULT_PATHS.DOWNLOADS,
            providerName,
            constants.DEFAULT_PATHS.EDITOR,
            constants.DEFAULT_PATHS.TRASH
        ),
    };
}

const config: IConfig = {
    providers: {
        ...DEFAULT_PROVIDERS.reduce((acc, provider) => {
            acc[provider] = generateDefaultPaths(provider);
            return acc;
        }, {} as Record<string, PathConfig>),
    },
    frontendDistPath: path.join(projectRoot, "..", "app", "build"),
    sharedStatePath: path.join(os.homedir(), constants.DIRECTORIES.SHARED_STATE_BASE),
    fc2FilePath: path.join(projectRoot, "..", "downloader", "fc2.txt"),
    scFilePath: path.join(projectRoot, "..", "downloader", "sc.txt"),
    tangoFilePath: path.join(projectRoot, "..", "downloader", "tango.txt"),
};

if (!fs.existsSync(config.frontendDistPath)) {
    fs.mkdirSync(config.frontendDistPath, { recursive: true });
}

if (!fs.existsSync(config.sharedStatePath)) {
    fs.mkdirSync(config.sharedStatePath, { recursive: true });
}

export const FRONTEND_DIST_PATH: string = config.frontendDistPath;
export const LIVE_STATUS_PATH: string = path.join(config.sharedStatePath, constants.FILE_NAMES.LIVE_STATUS);
export const FINALIZATION_DB_PATH: string = path.join(config.sharedStatePath, "finalization.sqlite");
export const ALIASES_PATH: string = path.join(config.sharedStatePath, "aliases.json");
export const FC2_FILE_PATH: string = config.fc2FilePath;
export const SC_FILE_PATH: string = config.scFilePath;
export const TANGO_FILE_PATH: string = config.tangoFilePath;
export const PORT = constants.API.PORT;

export function getProviderPaths(provider: string): PathConfig {
    const paths = config.providers[provider];
    if (!paths) {
        throw new Error(`Unknown provider: ${provider}`);
    }
    return paths;
}

export function getAllProviders(): string[] {
    return Object.keys(config.providers);
}
