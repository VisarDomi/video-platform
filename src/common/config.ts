import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface IConfig {
    sharedStatePath: string;
    sessionPath: string;
}

const sharedStatePath = path.join(os.homedir(), ".local", "share", "video-services");
const sessionPath = path.join(sharedStatePath, "session");

const defaultConfig: IConfig = {
    sharedStatePath,
    sessionPath,
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