// src/main.ts
import 'dotenv/config';
import * as fsPromises from 'fs/promises';
import * as timersPromises from 'timers/promises';
import * as path from 'path';
import * as child_process from 'child_process';

import * as config from './config.js';
import logger from './logger.js';
import * as utils from './utils.js';
import * as state from './state.js';
import * as requests from './requests.js';
import * as tokenManager from './tokenManager.js';
import * as repackager from './repackager.js';
import { AuthContext } from './authContext.js';


async function pollFollowingStreams(authContext: AuthContext) {
    logger.info('Starting stream watcher...');
    let lastKnownTotal = -1;

    while (true) {
        try {
            const streamIdsResponseBody = await requests.getFollowingResponseBody(authContext);

            const activeDownloads = state.getActiveDownloads();
            const currentTotal = activeDownloads.size;
            if (currentTotal !== lastKnownTotal) {
                logger.info(`Watching for streams... Total active/pending: ${currentTotal}`);
                lastKnownTotal = currentTotal;
            }

            if (streamIdsResponseBody?.entities?.stream) {
                const streamIds: string[] = Object.keys(streamIdsResponseBody.entities.stream);

                for (const streamId of streamIds) {
                    const stream = streamIdsResponseBody.entities.stream[streamId];
                    const masterPlaylistUrl = stream.playlistUrl;
                    const streamerId = stream.broadcasterId;

                    if (stream.kind === "PUBLIC" && streamerId && masterPlaylistUrl) {
                        if (!activeDownloads.has(masterPlaylistUrl)) {
                            activeDownloads.set(masterPlaylistUrl, {
                                streamerId: streamerId,
                                alias: streamerId,
                                liveUrl: null
                            });
                            logger.info(`Discovered new stream from ${streamerId}. Initiating download...`);
                            utils.updateStatusFile(authContext);
                            
                            initiateAndDownloadStream(streamerId, masterPlaylistUrl, authContext);
                        }
                    }
                }
            } else {
                logger.verbose("Poll complete: No stream entities found in the response.");
            }
        } catch (error) {
            logger.error("Failed to poll for following streams.", { error });
        }
        await timersPromises.setTimeout(config.getConfig().intervals.pollFollowing);
    }
}

async function initiateAndDownloadStream(streamerId: string, masterListUrl: string, authContext: AuthContext) {
    let alias = streamerId;
    let tsFilePath: string | null = null;
    let segmentsDirPath: string | null = null;
    let totalSegmentsDownloaded = 0;

    const downloadState = state.getActiveDownloads().get(masterListUrl);
    if (!downloadState) {
        logger.error(`Could not find state for download with master URL: ${masterListUrl}. Aborting.`);
        return;
    }

    try {
        alias = await requests.getStreamerAlias(streamerId, authContext);
        downloadState.alias = alias;
        utils.updateStatusFile(authContext);

        let liveUrl: string | null = null;
        const MAX_RETRIES = 3;
        const RETRY_DELAY = 5000;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            const resolvedUrl = await utils.getLiveUrlFromMaster(masterListUrl, authContext);
            if (resolvedUrl) {
                liveUrl = resolvedUrl;
                break;
            }
            logger.warn(`Failed to resolve live URL for ${alias} (attempt ${attempt}/${MAX_RETRIES}). Retrying in ${RETRY_DELAY / 1000}s...`);
            if (attempt < MAX_RETRIES) await timersPromises.setTimeout(RETRY_DELAY);
        }

        if (!liveUrl) {
            throw new Error(`Could not resolve live playlist URL for ${alias} after ${MAX_RETRIES} attempts.`);
        }

        downloadState.liveUrl = liveUrl;
        utils.updateStatusFile(authContext);

        const formattedDate = utils.getFormattedDate();
        const paths = utils.createPaths(alias, formattedDate);
        tsFilePath = paths.tsFilePath;
        segmentsDirPath = paths.segmentsDirPath;

        logger.info(`${formattedDate} ${alias} started downloading.`);
        logger.info(`- Live URL: ${liveUrl}`);
        logger.info(`- TS (growing): ${tsFilePath}`);
        logger.info(`- Segments will be saved to: ${segmentsDirPath}`);

        const ffmpegProcess = child_process.spawn('ffmpeg', [
            '-hide_banner', '-loglevel', 'error', '-stats',
            '-fflags', '+genpts', '-i', 'pipe:0', '-c', 'copy',
            '-f', 'mpegts', '-y', tsFilePath
        ]);
        ffmpegProcess.stderr.on('data', (data) => logger.verbose(`ffmpeg-ts (${path.basename(tsFilePath!)}): ${data.toString()}`));
        ffmpegProcess.on('error', (err) => logger.error(`Failed to start FFmpeg (ts) for ${alias}. Is ffmpeg installed?`, { error: err }));
        ffmpegProcess.stdin.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EPIPE') {
                logger.warn(`ffmpeg-ts (${alias}): Broken pipe. FFmpeg process likely closed prematurely.`);
            } else {
                logger.error(`ffmpeg-ts (${alias}): stdin stream error.`, { error: err });
            }
        });

        let lastOnline = Date.now();
        let first404Timestamp: number | null = null;
        const downloadedTsUrls: Set<string> = new Set();
        let lastSegmentDownloadedTimestamp = Date.now();

        while (true) {
            const liveResponse = await requests.getLiveList(liveUrl, authContext);
            if (liveResponse.success && liveResponse.data) {
                lastOnline = Date.now();
                first404Timestamp = null;
                const liveLines = utils.getResponseBodyLines(liveResponse.data);
                const cinemaApiUrl = masterListUrl.split("/v2/")[0];

                const segmentsToDownload: string[] = [];
                for (let i = 0; i < liveLines.length; i++) {
                    if (liveLines[i].startsWith("/v2/")) {
                        const tsUrl = `${cinemaApiUrl}${liveLines[i]}`;
                        if (!downloadedTsUrls.has(tsUrl)) {
                            segmentsToDownload.push(tsUrl);
                            downloadedTsUrls.add(tsUrl);
                        }
                    }
                }

                if (segmentsToDownload.length > 0) {
                    for (const tsUrl of segmentsToDownload) {
                        const tsBuffer = await requests.getTsSegment(tsUrl);
                        if (tsBuffer) {
                            lastSegmentDownloadedTimestamp = Date.now();
                            totalSegmentsDownloaded++;

                            if (!ffmpegProcess.stdin.destroyed) {
                                ffmpegProcess.stdin.write(tsBuffer);
                            }

                            try {
                                const tsNameHls = tsUrl.substring(tsUrl.lastIndexOf('/') + 1);
                                const tsName = tsNameHls.substring(0, tsNameHls.lastIndexOf('?'));
                                const segmentPath = path.join(segmentsDirPath, tsName);
                                fsPromises.writeFile(segmentPath, tsBuffer as unknown as Uint8Array);
                            } catch (error) {
                                logger.error(`Failed to save raw segment for ${alias}`, { error });
                            }
                        }
                    }
                }
            } else {
                if (liveResponse.status === 404) {
                    if (first404Timestamp === null) {
                        first404Timestamp = Date.now();
                        logger.warn(`Received first 404 for playlist of ${alias}. Will stop in ${config.getConfig().timeouts.streamEnd / 1000}s if it persists.`);
                    }
                }
            }
            
            if (Date.now() - lastSegmentDownloadedTimestamp > config.getConfig().timeouts.staleStream) {
                logger.info(`No new segments for ${alias} in ${config.getConfig().timeouts.staleStream / 1000}s. Assuming stream has ended.`);
                break;
            }

            if (first404Timestamp && (Date.now() - first404Timestamp > config.getConfig().timeouts.streamEnd)) {
                logger.info(`Stream for ${alias} appears to have ended (persistent 404). Stopping download.`);
                break;
            }
            if (Date.now() - lastOnline > config.getConfig().timeouts.networkBuffer) {
                logger.warn(`No successful playlist fetch for ${alias} in ${config.getConfig().timeouts.networkBuffer / 1000}s. Assuming stream/connection loss.`);
                break;
            }
            await timersPromises.setTimeout(config.getConfig().intervals.downloadBuffer);
        }

        if (!ffmpegProcess.stdin.destroyed) {
            ffmpegProcess.stdin.end();
        }

        await new Promise<void>((resolve) => ffmpegProcess.on('close', (code) => {
            logger.info(`FFmpeg (ts) process for ${alias} finished with code ${code}.`);
            resolve();
        }));

        if (totalSegmentsDownloaded === 0) {
            logger.warn(`No segments were downloaded for ${alias}, moving empty directory and file to trash.`);
            if (tsFilePath) await utils.moveToTrash(tsFilePath);
            if (segmentsDirPath) await utils.moveToTrash(segmentsDirPath);
        }

    } catch (error) {
        logger.error(`Download process for ${alias} failed fatally.`, { error });
    } finally {
        logger.info(`${utils.getFormattedDate()} Finished download process for: ${alias}`);
        state.getActiveDownloads().delete(masterListUrl);
        utils.updateStatusFile(authContext);
    }
}


async function processCompletedDownloads() {
    logger.info("[Repackager] Scanning storage path for completed downloads...");
    const cfg = config.getConfig();
    const storageDir = cfg.storagePath;

    try {
        const entries = await fsPromises.readdir(storageDir, { withFileTypes: true });
        
        const downloadFolderPattern = /^\d{4}-\d{2}-\d{2} \d{6} .+/;
        const potentialFolders = entries.filter(e => e.isDirectory() && downloadFolderPattern.test(e.name));

        const mp4Files = new Set(
            entries.filter(e => e.isFile() && e.name.endsWith('.mp4')).map(e => path.parse(e.name).name)
        );

        const tsFilesWithExt = new Set(
             entries.filter(e => e.isFile() && e.name.endsWith('.ts')).map(e => e.name)
        );

        for (const tsFile of tsFilesWithExt) {
            const baseName = path.parse(tsFile).name;
            if (mp4Files.has(baseName)) {
                const tsFilePath = path.join(storageDir, tsFile);
                logger.info(`[Repackager Cleanup] Moving stale .ts file to trash: ${tsFile}`);
                await utils.moveToTrash(tsFilePath);
            }
        }

        if (potentialFolders.length === 0) {
            logger.info("[Repackager] No download folders found to scan.");
            return;
        }
        
        for (const folder of potentialFolders) {
            if (folder.name === 'trash') continue;
            if (folder.name === 'edit') continue;

            const fullFolderPath = path.join(storageDir, folder.name);

            if (mp4Files.has(folder.name)) {
                if (cfg.repackager.deleteRawOnSuccess) {
                    logger.info(`[Repackager] Moving stale segment folder to trash: ${folder.name}`);
                    await utils.moveToTrash(fullFolderPath);
                }
                continue;
            }
            
            const isActive = Array.from(state.getActiveDownloads().values()).some(dl => {
                return folder.name.endsWith(dl.alias);
            });
            if (isActive) {
                logger.verbose(`[Repackager] Skipping all folders that have the same alias as ${folder.name}`);
                continue;
            }
            
            const stats = await fsPromises.stat(fullFolderPath);
            const staleTimeout = cfg.timeouts.staleStream * 2; 
            const isStale = (Date.now() - stats.mtime.getTime()) > staleTimeout;
            
            if (isStale) {
                try {
                    const dirEntries = await fsPromises.readdir(fullFolderPath);
                    if (dirEntries.length === 0) {
                        logger.warn(`[Repackager] Found empty stale folder '${folder.name}'. Moving to trash.`);
                        if (cfg.repackager.deleteRawOnSuccess) {
                            await utils.moveToTrash(fullFolderPath);
                            const bigTsFilePath = path.join(storageDir, `${folder.name}.ts`);
                            await utils.moveToTrash(bigTsFilePath);
                        }
                        continue;
                    }
                } catch (readError) {
                    logger.error(`[Repackager] Could not read contents of folder '${folder.name}'. Skipping.`, { readError });
                    continue;
                }

                logger.info(`[Repackager] Found stale, completed folder '${folder.name}'. Starting processing.`);
                await repackager.repackageFolder(fullFolderPath);

                if (cfg.repackager.deleteRawOnSuccess) {
                    await utils.moveToTrash(fullFolderPath);
                    const bigTsFilePath = path.join(storageDir, `${folder.name}.ts`);
                    await utils.moveToTrash(bigTsFilePath);
                }
            } else {
                 logger.verbose(`[Repackager] Folder '${folder.name}' is not stale yet. Skipping.`);
            }
        }
        logger.info("[Repackager] Scan complete.");

    } catch (error: any) {
        if (error.code === 'ENOENT') {
             logger.warn(`[Repackager] Storage path ${storageDir} does not exist. Skipping scan.`);
        } else {
            logger.error("[Repackager] Failed to scan for completed folders.", { error });
        }
    }
}


async function manageRepackaging() {
    logger.info("Starting repackager service...");
    if (config.getConfig().repackager.enabled) {
        await processCompletedDownloads();
    }
    
    while(true) {
        const scanInterval = config.getConfig().intervals.repackageScanMinutes * 60 * 1000;
        await timersPromises.setTimeout(scanInterval);

        try {
            if (config.getConfig().repackager.enabled) {
                logger.info("Periodic repackage scan triggered by manager.");
                await processCompletedDownloads();
            } else {
                logger.verbose("Repackager is disabled, skipping periodic scan.");
            }
        } catch(error) {
            logger.error("An unexpected error occurred in the repackager manager loop.", { error });
        }
    }
}


async function main() {
    logger.info("--- Starting Tango Downloader Service ---");
    logger.info("Starting initial authentication...");
    const manager = new tokenManager.TokenManager();
    await manager.initialAuth();
    const authContext = manager.getAuthContext();
    logger.info("Initial authentication successful.");
    
    // Pass the auth context to the main loops
    pollFollowingStreams(authContext);
    manageRepackaging();
    
    manager.startBackgroundJobs();
    logger.info("Background processes started (Token Refreshes).");
}

main();