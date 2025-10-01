// src/common/config.ts
import * as fs from "fs";
import * as path from "path";
import * as url from "url";

import * as utils from "./utils.js";

// --- Correct Path Resolution ---
const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = utils.findProjectRoot(__dirname)
const ROOT_CONFIG_PATH = path.resolve(projectRoot, "config.json");

export interface IConfig {
    storagePath: string;
    sharedStatePath: string;
    fileNames: {
        session: string;
        liveStatus: string;
        errorLog: string;
    };
    intervals: {
        pollFollowing: number;
        shortTokenRefresh: number;
        downloadBuffer: number;
    };
    timeouts: {
        staleStream: number;
    };
}

const defaultConfig: IConfig = {
    storagePath: "/home/visar/Videos/tango",
    sharedStatePath: "/home/visar/.local/share/tango-services",
    fileNames: {
        session: "session.json",
        liveStatus: "live-status.json",
        errorLog: "error.log",
    },
    intervals: {
        pollFollowing: 1000,
        shortTokenRefresh: 5000,
        downloadBuffer: 1000,
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
                    fileNames: { ...mergedConfig.fileNames, ...userConfig.fileNames },
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

let liveConfig = loadConfig();

export function getConfig(): IConfig {
    return liveConfig;
}

let debounceTimer: NodeJS.Timeout | null = null;

// --- THIS IS THE FIX ---
// Only watch for config changes when NOT running in a test environment.
if (process.env.NODE_ENV !== 'test') {
    fs.watch(ROOT_CONFIG_PATH, (eventType, filename) => {
        if (filename && eventType === "change") {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                console.log(`config.json changed. Reloading settings...`);
                liveConfig = loadConfig();
                debounceTimer = null;
            }, 100);
        }
    });
}
