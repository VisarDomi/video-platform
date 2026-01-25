import { promises as fsPromises } from "fs";
import path from "path";
import { spawn, ChildProcess } from "child_process";
import { createInterface } from "readline";
import pLimit from "p-limit";
import * as types from "../../core/types.js";
import * as config from "../../core/config.js";
import * as utils from "../../core/utils.js";
import * as constants from "../../core/constants.js";
import logger from "../../core/logger.js";

// --- Stateful Daemon Logic ---

let daemonProcess: ChildProcess | null = null;
let currentResolve: ((value: Record<string, number>) => void) | null = null;
const daemonLock = pLimit(1); // Serialize access to the daemon

function getDaemon(): ChildProcess {
    if (daemonProcess && !daemonProcess.killed) {
        return daemonProcess;
    }

    const projectRoot = utils.findProjectRoot();
    const binaryPath = path.join(projectRoot, "src", "core", "bin", "playlist-parser");

    daemonProcess = spawn(binaryPath);

    // Setup stdout listener
    const rl = createInterface({ input: daemonProcess.stdout! });
    rl.on('line', (line) => {
        if (currentResolve) {
            try {
                const result = JSON.parse(line);
                const resolve = currentResolve;
                currentResolve = null;
                resolve(result);
            } catch (err) {
                logger.error("Failed to parse Go output line", { err, line });
                // Don't leave the request hanging
                if (currentResolve) {
                    currentResolve({});
                    currentResolve = null;
                }
            }
        }
    });

    daemonProcess.stderr?.on('data', (data) => {
        logger.error(`Go Parser Stderr: ${data}`);
    });

    daemonProcess.on('exit', (code) => {
        logger.warn(`Go Parser exited with code ${code}`);
        daemonProcess = null;
        if (currentResolve) {
            currentResolve({});
            currentResolve = null;
        }
    });

    return daemonProcess;
}

function getDurationsFromGo(filePaths: string[]): Promise<Record<string, number>> {
    // We wrap this in daemonLock to ensure we only send one batch at a time
    // and wait for its specific response.
    return daemonLock(() => {
        return new Promise<Record<string, number>>((resolve) => {
            try {
                const process = getDaemon();
                currentResolve = resolve;

                // Write paths followed by the sentinel
                if (filePaths.length === 0) {
                    resolve({});
                    return;
                }

                process.stdin?.write(filePaths.join('\n') + '\n<<BATCH_END>>\n');
            } catch (error) {
                logger.error("Failed to communicate with Go daemon", { error });
                resolve({});
            }
        });
    });
}

// --- End Stateful Daemon Logic ---

export async function getAllVideos(provider: string = "tango"): Promise<{ videos: types.VideoItem[], timings: Record<string, number> }> {
    const timings: Record<string, number> = {};
    const tStart = Date.now();

    const liveFolders = await utils.getLiveFolders();
    timings['live-folders'] = Date.now() - tStart;

    const paths = config.getProviderPaths(provider);
    const providerPaths = [
        { path: paths.downloader, type: constants.ALL_VIDEO_PATHS_TYPES.ORIGINAL },
        { path: paths.edited, type: constants.ALL_VIDEO_PATHS_TYPES.EDITED },
        { path: paths.converted, type: constants.ALL_VIDEO_PATHS_TYPES.EDITED },
    ];

    // Phase 1: Readdir
    const tReaddirStart = Date.now();
    const allEntries: { name: string; fullPath: string; type: types.VideoType; playlistPath?: string }[] = [];

    await Promise.all(providerPaths.map(async (dirConfig) => {
        try {
            const entries = await fsPromises.readdir(dirConfig.path, { withFileTypes: true });
            entries.forEach(entry => {
                if (entry.isDirectory()) {
                    allEntries.push({
                        name: entry.name,
                        fullPath: path.join(dirConfig.path, entry.name),
                        type: dirConfig.type
                    });
                }
            });
        } catch (error) {
            // Directory might not exist or be inaccessible
        }
    }));
    timings['readdir'] = Date.now() - tReaddirStart;

    // Phase 2: Processing (Go Implementation)
    const tProcessStart = Date.now();

    // Prepare list for Go
    const pathsToProcess: string[] = [];
    const entryMap = new Map<string, typeof allEntries[0]>();

    allEntries.forEach(entry => {
        const isLive = liveFolders.has(entry.name);
        if (!isLive) {
            const playlistPath = path.join(entry.fullPath, constants.FILE_NAMES.HLS_PLAYLIST);
            entry.playlistPath = playlistPath;
            pathsToProcess.push(playlistPath);
            entryMap.set(playlistPath, entry);
        }
    });

    // Call Go (Now using Stateful Daemon)
    const durationMap = await getDurationsFromGo(pathsToProcess);

    const videos: types.VideoItem[] = allEntries.map(entry => {
        const isLive = liveFolders.has(entry.name);
        let duration = 0;

        if (isLive) {
            duration = 0;
        } else if (entry.playlistPath && durationMap[entry.playlistPath] !== undefined) {
            duration = durationMap[entry.playlistPath];
        }

        return {
            filename: entry.name,
            type: entry.type,
            size: 0,
            duration: duration,
            isLive: isLive
        };
    });

    timings['duration-calc'] = Date.now() - tProcessStart;

    // Phase 3: Sorting
    const tSortStart = Date.now();
    videos.sort((a, b) => a.filename.localeCompare(b.filename));
    timings['sorting'] = Date.now() - tSortStart;

    // Stats
    timings['count'] = videos.length;

    return { videos, timings };
}