// src/common/config.ts
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface IConfig {
    sharedStatePath: string;
}

const defaultConfig: IConfig = {
    // Use the XDG Base Directory Specification for user-specific data files.
    // This is the standard "Linux way" for services running under a specific user.
    sharedStatePath: path.join(os.homedir(), ".local", "share", "tango-services"),
};

/**
 * Ensures that the directory for shared state files (like session.json) exists.
 * This prevents errors when services try to write files for the first time.
 */
function ensureSharedPathExists(config: IConfig) {
    if (config.sharedStatePath) {
        try {
            if (!fs.existsSync(config.sharedStatePath)) {
                fs.mkdirSync(config.sharedStatePath, { recursive: true });
                console.log(`Created shared state directory: ${config.sharedStatePath}`);
            }
        } catch (error) {
            console.error(`Failed to create shared state directory at ${config.sharedStatePath}`, { error });
        }
    }
}

ensureSharedPathExists(defaultConfig); // Run once on startup

export function getConfig(): IConfig {
    return defaultConfig;
}
