import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface IConfig {
    sharedStatePath: string;
    sessionPath: string;
    // The accounts to keep signed in (email, password, provider), outside the repository so a
    // fresh clone loses nothing. Private like the pipeline's upload credentials beside it.
    accountsPath: string;
}

const sharedStatePath = path.join(os.homedir(), ".local", "share", "video-services");
const sessionPath = path.join(sharedStatePath, "session");

const defaultConfig: IConfig = {
    sharedStatePath,
    sessionPath,
    accountsPath: process.env.VIDEO_AUTH_ACCOUNTS_FILE
        ?? path.join(os.homedir(), ".config", "video-services", "auth-accounts.json"),
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