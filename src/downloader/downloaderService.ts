// src/downloader/downloaderService.ts
import * as fsPromises from "fs/promises";
import * as timersPromises from "timers/promises";
import * as path from "path";

import * as config from "../common/config.js";
import logger from "../common/logger.js";
import * as storage from "../common/storage.js";

import * as requests from "./requests.js";
import { DownloadsManager, DownloadHandle } from "./downloadsManager.js";
import { findBestStreamUrl } from "./hlsUtils.js";

export class DownloaderService {
    private downloadsManager: DownloadsManager;
    private tokens: requests.Tokens | null = null;

    /**
     * The constructor is now private. Use the async `create` method instead.
     */
    private constructor(downloadsManager: DownloadsManager) {
        this.downloadsManager = downloadsManager;
        logger.info("DownloaderService initialized.");
    }

    /**
     * Asynchronously creates and initializes a DownloaderService.
     */
    public static async create(): Promise<DownloaderService> {
        const downloadsManager = await DownloadsManager.create();
        return new DownloaderService(downloadsManager);
    }

    public start() {
        logger.info("Starting Downloader Service...");
        this._startTokenWatcher();
        this._startStreamWatcher();
    }

    private async _startTokenWatcher() {
        const refreshInterval = config.getConfig().intervals.shortTokenRefresh;
        while (true) {
            try {
                const cfg = config.getConfig();
                const sessionFilePath = path.resolve(cfg.sharedStatePath, "session.json");

                const data = await fsPromises.readFile(sessionFilePath, "utf-8");
                const session = JSON.parse(data);

                if (session.tangoST && session.tt && session.ttu && session.tte) {
                    this.tokens = {
                        st: session.tangoST,
                        tt: session.tt,
                        ttu: session.ttu,
                        tte: session.tte,
                    };
                } else {
                    if (this.tokens) logger.warn("Session file is missing required tokens. Clearing internal state.");
                    this.tokens = null;
                }
            } catch (error: any) {
                if (error.code !== "ENOENT") {
                    logger.error("Failed to read tokens from session file", { error });
                }
                if (this.tokens) logger.warn("Session file not found. Clearing internal token state.");
                this.tokens = null;
            }
            await timersPromises.setTimeout(refreshInterval);
        }
    }

    private async _startStreamWatcher() {
        let lastKnownTotal = -1;

        while (true) {
            try {
                if (!this.tokens) {
                    logger.warn("Tokens not available. Downloader is waiting for auth service to provide them...");
                    await timersPromises.setTimeout(config.getConfig().intervals.shortTokenRefresh);
                    continue;
                }

                const streamIdsResponseBody = await requests.getFollowingResponseBody(this.tokens);

                const currentTotal = this.downloadsManager.size;
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
                            if (!this.downloadsManager.has(masterPlaylistUrl)) {
                                logger.info(`Discovered new stream from ${streamerId}. Initiating download...`);
                                const downloadHandle = this.downloadsManager.add(masterPlaylistUrl, {
                                    streamerId: streamerId,
                                    alias: streamerId,
                                });
                                if (downloadHandle) {
                                    this._initiateAndDownloadStream(downloadHandle);
                                }
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

    private async _initiateAndDownloadStream(downloadHandle: DownloadHandle) {
        let tsFilePath: string | null = null;
        let segmentsDirPath: string | null = null;
        let alias: string;

        try {
            if (!downloadHandle.state) {
                logger.error(`Could not find state for download with handle. Aborting.`);
                return;
            }

            const { streamerId } = downloadHandle.state;
            alias = downloadHandle.state.alias;

            if (!this.tokens) throw new Error(`Tokens not available at start of download for ${streamerId}`);

            alias = await requests.getStreamerAlias(streamerId, this.tokens);
            downloadHandle.update({ alias });

            let liveUrl: string | null = null;
            const MAX_RETRIES = 3;
            const RETRY_DELAY = 5000;

            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                if (!this.tokens) throw new Error("Tokens disappeared while resolving live URL.");
                const resolvedUrl = await this._getLiveUrlFromMaster(downloadHandle);
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

            downloadHandle.update({ liveUrl });
            
            const startDate = new Date();
            const paths = storage.createDownloadPaths(alias, startDate);
            tsFilePath = paths.tsFilePath;
            segmentsDirPath = paths.segmentsDirPath;

            downloadHandle.update({ tsFilePath, segmentsDirPath });

            logger.info(`${tsFilePath} started downloading segments.`);
            logger.info(`- Live URL: ${liveUrl}`);
            logger.info(`- Segments will be saved to: ${segmentsDirPath}`);

            const downloadedTsUrls: Set<string> = new Set();
            let lastDownload = Date.now();

            while (true) {
                if (!this.tokens) {
                    logger.warn(`Tokens became unavailable for ${tsFilePath} mid-stream. Assuming stream has ended.`);
                    break;
                }

                const liveResponse = await requests.getLiveList(liveUrl, this.tokens);

                if (liveResponse.success && liveResponse.data) {
                    const liveLines = liveResponse.data.split("\n").filter((line) => line.trim() !== "");
                    const cinemaApiUrl = downloadHandle.masterPlaylistUrl.split("/v2/")[0];

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
                                try {
                                    const tsNameHls = tsUrl.substring(tsUrl.lastIndexOf("/") + 1);
                                    const tsName = tsNameHls.substring(0, tsNameHls.lastIndexOf("?"));
                                    const segmentPath = path.join(segmentsDirPath, tsName);
                                    fsPromises.writeFile(segmentPath, tsBuffer as unknown as Uint8Array);
                                    lastDownload = Date.now();
                                } catch (error) {
                                    logger.error(`Failed to save raw segment for ${tsFilePath}`, { error });
                                }
                            }
                        }
                    }
                }

                if (Date.now() - lastDownload > config.getConfig().timeouts.staleStream) {
                    logger.info(`No new segments for ${tsFilePath} in ${config.getConfig().timeouts.staleStream / 1000}s. Assuming stream has ended.`);
                    break;
                }
                await timersPromises.setTimeout(1000);
            }
        } catch (error) {
            logger.error(`Download process for ${tsFilePath} failed fatally.`, { error });
        } finally {
            logger.info(`Finished download process for: ${tsFilePath}`);
            downloadHandle.remove();
        }
    }

    private async _getLiveUrlFromMaster(downloadHandle: DownloadHandle): Promise<string | null> {
        if (!this.tokens) return null;
        try {
            const masterListBody = await requests.getMasterList(downloadHandle.masterPlaylistUrl, this.tokens);
            if (!masterListBody) {
                logger.warn(`Could not fetch master playlist body from: ${downloadHandle.masterPlaylistUrl} for ${downloadHandle.state?.tsFilePath}`);
                return null;
            }

            const relativeLiveUrl = findBestStreamUrl(masterListBody);

            if (!relativeLiveUrl) {
                logger.warn(`Could not find HD stream in master playlist: ${downloadHandle.masterPlaylistUrl} for ${downloadHandle.state?.tsFilePath}`);
                return null;
            }
            const cinemaApiUrl = downloadHandle.masterPlaylistUrl.split("/v2/")[0];
            let livePlaylistUrl = `${cinemaApiUrl}${relativeLiveUrl}`;
            if (livePlaylistUrl.endsWith("&")) {
                livePlaylistUrl = livePlaylistUrl.substring(0, livePlaylistUrl.length - 1);
            }
            return livePlaylistUrl;
        } catch (error) {
            logger.error(`Error resolving live URL from master: ${downloadHandle.masterPlaylistUrl} for ${downloadHandle.state?.tsFilePath}`, { error });
            return null;
        }
    }
}
