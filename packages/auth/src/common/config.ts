import * as fs from "fs";
import * as path from "path";
import { authAccountsPath, servicesHome } from "shared";

export interface IConfig {
    sharedStatePath: string;
    sessionPath: string;
    // The accounts to keep signed in (email, password, provider), outside the repository so a
    // fresh clone loses nothing. Private like the pipeline's upload credentials beside it.
    accountsPath: string;
}

// The session files are the core credential store's (session/<account>.json under the
// services' home-relative folder).
const sharedStatePath = servicesHome();
const sessionPath = path.join(sharedStatePath, "session");

const defaultConfig: IConfig = {
    sharedStatePath,
    sessionPath,
    accountsPath: authAccountsPath(),
};

function ensurePathsExist(config: IConfig) {
    try {
        if (!fs.existsSync(config.sharedStatePath)) {
            fs.mkdirSync(config.sharedStatePath, { recursive: true });
        }
        if (!fs.existsSync(config.sessionPath)) {
            fs.mkdirSync(config.sessionPath, { recursive: true });
        }
    } catch (error) {
        console.error(`Failed to create required directories`, { error });
        process.exit(1);
    }
}

ensurePathsExist(defaultConfig);

export function getConfig(): IConfig {
    return defaultConfig;
}
