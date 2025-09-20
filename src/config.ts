// config.ts
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.resolve(__dirname, "..", "config.json");

// Define an interface for strong typing that matches the new structure
interface IConfig {
  storagePath: string; // <-- UPDATED
  fileNames: {
    session: string;
    liveStatus: string;
    errorLog: string;
  };
  intervals: {
    pollFollowing: number;
    manageDownloads: number;
    shortTokenRefresh: number;
    longTokenRefreshMinutes: number;
    downloadBuffer: number;
    orphanScanMinutes: number; // <-- NEW
  };
  timeouts: {
    streamEnd: number;
    networkBuffer: number;
    staleStream: number;
  };
  repackager: {
    enabled: boolean;
    enforceResolution: string | null;
    maxWorkers: number;
    repairPreset: string;
    repairCrf: string;
    deleteRawOnSuccess: boolean;
  };
}

// Update the default configuration to match the new structure
const defaultConfig: IConfig = {
  storagePath: "/home/visar/Documents/tango", // <-- UPDATED (sensible default)
  fileNames: {
    session: "session.json",
    liveStatus: "live-status.json",
    errorLog: "error.log",
  },
  intervals: {
    pollFollowing: 1000,
    manageDownloads: 1000,
    shortTokenRefresh: 5000,
    longTokenRefreshMinutes: 30,
    downloadBuffer: 1000,
    orphanScanMinutes: 5, // <-- NEW
  },
  timeouts: {
    streamEnd: 10000,
    networkBuffer: 100000,
    staleStream: 15000,
  },
  repackager: {
    enabled: true,
    enforceResolution: "720x1280",
    maxWorkers: Math.floor(os.cpus().length * 0.5) || 4,
    repairPreset: "veryfast",
    repairCrf: "18",
    deleteRawOnSuccess: true
  }
};

function loadConfig(): IConfig {
    let userConfig: Partial<IConfig> = {};
    let newConfig: IConfig = defaultConfig;
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const fileContent = fs.readFileSync(CONFIG_PATH, 'utf-8');
            userConfig = JSON.parse(fileContent);
        }
        // Deep merge the user config over the defaults
        newConfig = {
            ...defaultConfig,
            ...userConfig,
            fileNames: {
                ...defaultConfig.fileNames,
                ...userConfig.fileNames,
            },
            intervals: {
                ...defaultConfig.intervals,
                ...userConfig.intervals,
            },
            timeouts: {
                ...defaultConfig.timeouts,
                ...userConfig.timeouts,
            },
            repackager: {
                ...defaultConfig.repackager,
                ...userConfig.repackager
            }
        };
    } catch (error) {
        console.error(`Error reading or parsing config.json. Using default settings.`, { error });
        return defaultConfig;
    }

    console.log(`Configuration has been loaded/reloaded.`);
    return newConfig;
}

let liveConfig = loadConfig();

export function getConfig(): IConfig {
    return liveConfig;
}

let debounceTimer: NodeJS.Timeout | null = null;

fs.watch(CONFIG_PATH, (eventType, filename) => {
    if (filename && eventType === 'change') {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
            console.log(`config.json changed. Reloading settings...`);
            liveConfig = loadConfig();
            debounceTimer = null;
        }, 100);
    }
});