import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as utils from "./utils.js";
import * as constants from "./constants.js";
import { downloadListPath, providerFolders } from "shared";

const projectRoot = utils.findProjectRoot();

interface PathConfig {
    downloaded: string;
    edited: string;
    trash: string;
}

interface IConfig {
    providers: Record<string, PathConfig>;
    frontendDistPath: string;
    sharedStatePath: string;
    ladderFilePath: string;
    scFilePath: string;
    tsliveFilePath: string;
}

const DEFAULT_PROVIDERS = ["tslive", "ladder", "fmp4"];

// The layout lives in the shared package: the single source of truth.
function generateDefaultPaths(providerName: string): PathConfig {
    return providerFolders(providerName);
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
    ladderFilePath: downloadListPath("ladder"),
    scFilePath: downloadListPath("fmp4"),
    tsliveFilePath: downloadListPath("tslive"),
};

if (!fs.existsSync(config.frontendDistPath)) {
    fs.mkdirSync(config.frontendDistPath, { recursive: true });
}

fs.mkdirSync(path.dirname(config.tsliveFilePath), { recursive: true });

if (!fs.existsSync(config.sharedStatePath)) {
    fs.mkdirSync(config.sharedStatePath, { recursive: true });
}

export const FRONTEND_DIST_PATH: string = config.frontendDistPath;
export const SHARED_STATE_PATH: string = config.sharedStatePath;
export const LIVE_STATUS_PATH: string = path.join(config.sharedStatePath, constants.FILE_NAMES.LIVE_STATUS);
export const FINALIZATION_DB_PATH: string = path.join(config.sharedStatePath, "finalization.sqlite");
export const ALIASES_PATH: string = path.join(config.sharedStatePath, "aliases.json");
export const LADDER_FILE_PATH: string = config.ladderFilePath;
export const FMP4_FILE_PATH: string = config.scFilePath;
export const TSLIVE_FILE_PATH: string = config.tsliveFilePath;
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
