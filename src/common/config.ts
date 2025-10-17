// src/common/config.ts
import * as fs from "fs";
import * as path from "path";
import * as url from "url";
import * as os from "os";

import * as utils from "./utils.js";

// --- Correct Path Resolution ---
const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = utils.findProjectRoot(__dirname);
const ROOT_CONFIG_PATH = path.resolve(projectRoot, "config.json");

export interface IConfig {
    storagePath: string;
    sharedStatePath: string;
    intervals: {
        pollFollowing: number;
        shortTokenRefresh: number;
    };
    timeouts: {
        staleStream: number;
    };
}

const defaultConfig: IConfig = {
    storagePath: "/home/visar/Videos/tango",
    // Use the XDG Base Directory Specification for user-specific data files.
    // This is the standard "Linux way" for services running under a specific user.
    sharedStatePath: path.join(os.homedir(), ".local", "share", "video-services"),
    intervals: {
        pollFollowing: 1000,
        shortTokenRefresh: 5000,
    },
    timeouts: {
        staleStream: 15000,
    },
};

function loadConfig(): IConfig {
    let mergedConfig = { ...defaultConfig };

    const loadAndMerge = (filePath: string) => {
        if (fs.existsSync(filePath)) {
            try {
                const fileContent = fs.readFileSync(filePath, "utf-8");
                const userConfig = JSON.parse(fileContent);
                mergedConfig = {
                    ...mergedConfig,
                    ...userConfig,
                    intervals: { ...mergedConfig.intervals, ...userConfig.intervals },
                    timeouts: { ...mergedConfig.timeouts, ...userConfig.timeouts },
                };
            } catch (error) {
                console.error(`Error reading or parsing config file at ${filePath}.`, { error });
            }
        }
    };

    loadAndMerge(ROOT_CONFIG_PATH);
    loadAndMerge(path.resolve(process.cwd(), "config.json"));

    console.log(`Configuration has been loaded/reloaded.`);
    return mergedConfig;
}

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

let liveConfig = loadConfig();
ensureSharedPathExists(liveConfig); // Run once on startup

export function getConfig(): IConfig {
    return liveConfig;
}

let debounceTimer: NodeJS.Timeout | null = null;

// Only watch for config changes when NOT running in a test environment.
if (process.env.NODE_ENV !== "test") {
    fs.watch(ROOT_CONFIG_PATH, (eventType, filename) => {
        if (filename && eventType === "change") {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                console.log(`config.json changed. Reloading settings...`);
                liveConfig = loadConfig();
                ensureSharedPathExists(liveConfig); // Also run on reload
                debounceTimer = null;
            }, 100);
        }
    });
}
