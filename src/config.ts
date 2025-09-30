// src/config.ts
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import * as os from 'os';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_CONFIG_PATH = path.resolve(__dirname, "..", "config.json");

export interface IConfig {
  storagePath: string;
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
    repackageScanMinutes: number;
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
    deleteRawOnSuccess: boolean;
  };
}

const defaultConfig: IConfig = {
  storagePath: "/home/visar/Documents/tango",
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
    repackageScanMinutes: 5,
  },
  timeouts: {
    streamEnd: 10000,
    networkBuffer: 100000,
    staleStream: 15000,
  },
  repackager: {
    enabled: true,
    enforceResolution: "720x1280",
    maxWorkers: Math.min(Math.floor(os.cpus().length * 0.75), 8) || 4,
    deleteRawOnSuccess: true
  }
};

function loadConfig(): IConfig {
    let mergedConfig = { ...defaultConfig };

    const loadAndMerge = (filePath: string) => {
        if (fs.existsSync(filePath)) {
            try {
                const fileContent = fs.readFileSync(filePath, 'utf-8');
                const userConfig = JSON.parse(fileContent);
                // Deep merge logic
                mergedConfig = {
                    ...mergedConfig,
                    ...userConfig,
                    fileNames: { ...mergedConfig.fileNames, ...userConfig.fileNames },
                    intervals: { ...mergedConfig.intervals, ...userConfig.intervals },
                    timeouts: { ...mergedConfig.timeouts, ...userConfig.timeouts },
                    repackager: { ...mergedConfig.repackager, ...userConfig.repackager }
                };
            } catch (error) {
                console.error(`Error reading or parsing config file at ${filePath}.`, { error });
            }
        }
    };

    // --> FIX: Load in hierarchical order: defaults -> root config -> cwd config
    // 1. Defaults are already set.
    // 2. Merge root config file.
    loadAndMerge(ROOT_CONFIG_PATH);
    // 3. Merge CWD config file (will override root settings if present, which is what the test needs).
    loadAndMerge(path.resolve(process.cwd(), "config.json"));
    
    console.log(`Configuration has been loaded/reloaded.`);
    return mergedConfig;
}

let liveConfig = loadConfig();

export function getConfig(): IConfig {
    return liveConfig;
}

let debounceTimer: NodeJS.Timeout | null = null;
// Watch the root config for changes in normal operation
fs.watch(ROOT_CONFIG_PATH, (eventType, filename) => {
    if (filename && eventType === 'change') {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            console.log(`config.json changed. Reloading settings...`);
            liveConfig = loadConfig();
            debounceTimer = null;
        }, 100);
    }
});