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
  downloader: {
    enabled: boolean;
  };
  repackager: {
    enabled: boolean;
    enforceResolution: string | null;
    maxWorkers: number;
    deleteRawOnSuccess: boolean;
  };
  combiner: { // <-- NEW SECTION
    enabled: boolean;
    scanIntervalHours: number;
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
  downloader: {
    enabled: true,
  },
  repackager: {
    enabled: true,
    enforceResolution: "720x1280",
    maxWorkers: Math.min(Math.floor(os.cpus().length * 0.75), 8) || 4,
    deleteRawOnSuccess: true
  },
  combiner: { // <-- NEW SECTION
    enabled: false, // Default to off
    scanIntervalHours: 6
  }
};

function loadConfig(): IConfig {
    let mergedConfig = { ...defaultConfig };

    const loadAndMerge = (filePath: string) => {
        if (fs.existsSync(filePath)) {
            try {
                const fileContent = fs.readFileSync(filePath, 'utf-8');
                const userConfig = JSON.parse(fileContent);
                mergedConfig = {
                    ...mergedConfig,
                    ...userConfig,
                    fileNames: { ...mergedConfig.fileNames, ...userConfig.fileNames },
                    intervals: { ...mergedConfig.intervals, ...userConfig.intervals },
                    timeouts: { ...mergedConfig.timeouts, ...userConfig.timeouts },
                    downloader: { ...mergedConfig.downloader, ...userConfig.downloader },
                    repackager: { ...mergedConfig.repackager, ...userConfig.repackager },
                    combiner: { ...mergedConfig.combiner, ...userConfig.combiner } // <-- NEW
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