// src/tango.ts
import { getConfig } from './config.js';
import logger from './logger.js';
import * as u from './utils.js';
import * as s from './state.js';
import * as r from './requests.js';
import * as a from './auth.js';
import { promises as fsPromises } from 'fs';
import { setTimeout as delay } from 'timers/promises';
import 'dotenv/config';
import path from 'path';
import { repackageFolder } from './repackager.js';
import { spawn } from 'child_process';


async function pollFollowingStreams() {
    logger.info('Starting stream watcher...');
    let lastKnownTotal = -1;

    while (true) {
        try {
            const streamIdsResponseBody = await r.getFollowingResponseBody();

            const activeDownloads = s.getActiveDownloads();
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
                            u.updateStatusFile();
                            
                            initiateAndDownloadStream(streamerId, masterPlaylistUrl);
                        }
                    }
                }
            } else {
                logger.verbose("Poll complete: No stream entities found in the response.");
            }
        } catch (error) {
            logger.error("Failed to poll for following streams.", { error });
        }
        await delay(getConfig().intervals.pollFollowing);
    }
}

async function initiateAndDownloadStream(streamerId: string, masterListUrl: string) {
    let alias = streamerId;
    let tsFilePath: string | null = null;
    let segmentsDirPath: string | null = null;
    let totalSegmentsDownloaded = 0;

    const downloadState = s.getActiveDownloads().get(masterListUrl);
    if (!downloadState) {
        logger.error(`Could not find state for download with master URL: ${masterListUrl}. Aborting.`);
        return;
    }

    try {
        alias = await r.getStreamerAlias(streamerId);
        downloadState.alias = alias;
        u.updateStatusFile();

        let liveUrl: string | null = null;
        const MAX_RETRIES = 3;
        const RETRY_DELAY = 5000;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            const resolvedUrl = await u.getLiveUrlFromMaster(masterListUrl);
            if (resolvedUrl) {
                liveUrl = resolvedUrl;
                break;
            }
            logger.warn(`Failed to resolve live URL for ${alias} (attempt ${attempt}/${MAX_RETRIES}). Retrying in ${RETRY_DELAY / 1000}s...`);
            if (attempt < MAX_RETRIES) await delay(RETRY_DELAY);
        }

        if (!liveUrl) {
            throw new Error(`Could not resolve live playlist URL for ${alias} after ${MAX_RETRIES} attempts.`);
        }

        downloadState.liveUrl = liveUrl;
        u.updateStatusFile();

        const formattedDate = u.getFormattedDate();
        const paths = u.createPaths(alias, formattedDate);
        tsFilePath = paths.tsFilePath;
        segmentsDirPath = paths.segmentsDirPath;

        logger.info(`${formattedDate} ${alias} started downloading.`);
        logger.info(`- Live URL: ${liveUrl}`);
        logger.info(`- TS (growing): ${tsFilePath}`);
        logger.info(`- Segments will be saved to: ${segmentsDirPath}`);

        const ffmpegProcess = spawn('ffmpeg', [
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
            const liveResponse = await r.getLiveList(liveUrl);
            if (liveResponse.success && liveResponse.data) {
                lastOnline = Date.now();
                first404Timestamp = null;
                const liveLines = u.getResponseBodyLines(liveResponse.data);
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
                        const tsBuffer = await r.getTsSegment(tsUrl);
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
                        logger.warn(`Received first 404 for playlist of ${alias}. Will stop in ${getConfig().timeouts.streamEnd / 1000}s if it persists.`);
                    }
                }
            }
            
            if (Date.now() - lastSegmentDownloadedTimestamp > getConfig().timeouts.staleStream) {
                logger.info(`No new segments for ${alias} in ${getConfig().timeouts.staleStream / 1000}s. Assuming stream has ended.`);
                break;
            }

            if (first404Timestamp && (Date.now() - first404Timestamp > getConfig().timeouts.streamEnd)) {
                logger.info(`Stream for ${alias} appears to have ended (persistent 404). Stopping download.`);
                break;
            }
            if (Date.now() - lastOnline > getConfig().timeouts.networkBuffer) {
                logger.warn(`No successful playlist fetch for ${alias} in ${getConfig().timeouts.networkBuffer / 1000}s. Assuming stream/connection loss.`);
                break;
            }
            await delay(getConfig().intervals.downloadBuffer);
        }

        if (!ffmpegProcess.stdin.destroyed) {
            ffmpegProcess.stdin.end();
        }

        await new Promise<void>((resolve) => ffmpegProcess.on('close', (code) => {
            logger.info(`FFmpeg (ts) process for ${alias} finished with code ${code}.`);
            resolve();
        }));

        if (totalSegmentsDownloaded === 0) {
            logger.warn(`No segments were downloaded for ${alias}, deleting empty directory and file.`);
            if (tsFilePath) await fsPromises.unlink(tsFilePath).catch(e => { if (e.code !== 'ENOENT') throw e; });
            if (segmentsDirPath) await fsPromises.rm(segmentsDirPath, { recursive: true, force: true }).catch(e => { if (e.code !== 'ENOENT') throw e; });
        }

    } catch (error) {
        logger.error(`Download process for ${alias} failed fatally.`, { error });
    } finally {
        logger.info(`${u.getFormattedDate()} Finished download process for: ${alias}`);
        s.getActiveDownloads().delete(masterListUrl);
        u.updateStatusFile();
    }
}


async function processCompletedDownloads() {
    logger.info("[Repackager] Scanning storage path for completed downloads...");
    const config = getConfig();
    const storageDir = config.storagePath;

    try {
        const entries = await fsPromises.readdir(storageDir, { withFileTypes: true });
        
        const downloadFolderPattern = /^\d{4}-\d{2}-\d{2} \d{6} .+/;
        const potentialFolders = entries.filter(e => e.isDirectory() && downloadFolderPattern.test(e.name));

        const mp4Files = new Set(
            entries.filter(e => e.isFile() && e.name.endsWith('.mp4')).map(e => path.parse(e.name).name)
        );

        // --- CHANGE START: Added .ts file cleanup logic ---
        const tsFiles = new Set(
             entries.filter(e => e.isFile() && e.name.endsWith('.ts')).map(e => path.parse(e.name).name)
        );

        for (const baseName of tsFiles) {
            if (mp4Files.has(baseName)) {
                const tsFilePath = path.join(storageDir, `${baseName}.ts`);
                logger.info(`[Repackager Cleanup] Deleting stale .ts file with existing MP4: ${baseName}.ts`);
                await fsPromises.unlink(tsFilePath).catch(err => logger.error(`Failed to delete stale .ts file: ${tsFilePath}`, { err }));
            }
        }
        // --- CHANGE END ---

        if (potentialFolders.length === 0) {
            logger.info("[Repackager] No download folders found to scan.");
            return;
        }
        
        for (const folder of potentialFolders) {
            const fullFolderPath = path.join(storageDir, folder.name);

            if (mp4Files.has(folder.name)) {
                if (config.repackager.deleteRawOnSuccess) {
                    logger.info(`[Repackager] Deleting stale segment folder with existing MP4: ${folder.name}`);
                    await fsPromises.rm(fullFolderPath, { recursive: true, force: true });
                }
                continue;
            }
            
            const isActive = Array.from(s.getActiveDownloads().values()).some(dl => {
                // A simple check to see if the streamer alias is at the end of the folder name
                return folder.name.endsWith(dl.alias);
            });
            if(isActive) {
                logger.verbose(`[Repackager] Folder '${folder.name}' belongs to an active download. Skipping.`);
                continue;
            }

            const stats = await fsPromises.stat(fullFolderPath);
            const staleTimeout = config.timeouts.staleStream * 2; 
            const isStale = (Date.now() - stats.mtime.getTime()) > staleTimeout;
            
            if (isStale) {
                logger.info(`[Repackager] Found stale, completed folder '${folder.name}'. Starting processing.`);
                await repackageFolder(fullFolderPath);
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
    if (getConfig().repackager.enabled) {
        await processCompletedDownloads();
    }
    
    while(true) {
        const scanInterval = getConfig().intervals.repackageScanMinutes * 60 * 1000;
        await delay(scanInterval);

        try {
            if (getConfig().repackager.enabled) {
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
    await a.initialAuth();
    logger.info("Initial authentication successful.");
    
    manageRepackaging();
    a.refreshShortLivedTokens();
    a.manageTokenLifecycle();
    logger.info("Background processes started (Repackager, Token Refreshes).");

    pollFollowingStreams();

    logger.info("Downloader service is now running and polling for streams.");
}

main();