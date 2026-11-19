import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as utils from "./utils.js";
import * as constants from "./constants.js";
import { providerFolders, servicesDataRoot } from "shared";

const projectRoot = utils.findProjectRoot();

interface PathConfig {
    downloaded: string;
    edited: string;
    trash: string;
}

interface IConfig {
    frontendDistPath: string;
    sharedStatePath: string;
}

const config: IConfig = {
    frontendDistPath: path.join(projectRoot, "..", "app", "build"),
    sharedStatePath: path.join(os.homedir(), constants.DIRECTORIES.SHARED_STATE_BASE),
};

if (!fs.existsSync(config.frontendDistPath)) {
    fs.mkdirSync(config.frontendDistPath, { recursive: true });
}

// The download lists' folder (shared/providerLayout's downloadListPath).
fs.mkdirSync(path.join(servicesDataRoot, "download-lists"), { recursive: true });

if (!fs.existsSync(config.sharedStatePath)) {
    fs.mkdirSync(config.sharedStatePath, { recursive: true });
}

export const FRONTEND_DIST_PATH: string = config.frontendDistPath;
export const SHARED_STATE_PATH: string = config.sharedStatePath;
export const LIVE_STATUS_PATH: string = path.join(config.sharedStatePath, constants.FILE_NAMES.LIVE_STATUS);
export const FINALIZATION_DB_PATH: string = path.join(config.sharedStatePath, "finalization.sqlite");
export const ALIASES_PATH: string = path.join(config.sharedStatePath, "aliases.json");
export const PORT = constants.API.PORT;

// The sites whose recordings this process serves (<downloads root>/<site>/...): the
// capture sites of the sites file, in its order, set once at startup. Until then none is
// known. The layout lives in the shared package: the single source of truth.
const providers = new Map<string, PathConfig>();

export function configureProviders(siteIds: readonly string[]): void {
    providers.clear();
    for (const siteId of siteIds) providers.set(siteId, providerFolders(siteId));
}

export function getProviderPaths(provider: string): PathConfig {
    const paths = providers.get(provider);
    if (!paths) {
        throw new Error(`Unknown provider: ${provider}`);
    }
    return paths;
}

export function getAllProviders(): string[] {
    return [...providers.keys()];
}

// The provider a request without one means: the first capture site in the sites file
// (production lists its former fixed default first).
export function defaultProvider(): string {
    return getAllProviders()[0] ?? "";
}
