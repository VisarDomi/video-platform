// src/downloader/downloaderService.ts
import * as fsPromises from "fs/promises";
import * as timersPromises from "timers/promises";
import * as path from "path";

import * as config from "../common/config.js";
import logger from "../common/logger.js";
import * as storage from "../common/storage.js";

import * as requests from "./requests.js";
import { DownloadsManager, DownloadHandle } from "./downloadsManager.js";
import { AliasManager } from "../common/aliasManager.js";

export class DownloaderService {
    private downloadsManager: DownloadsManager;
    private aliasManager: AliasManager;
    private tokens: requests.Tokens | null = null;

    /**
     * The constructor is now private. Use the async `create` method instead.
     */
    private constructor(downloadsManager: DownloadsManager, aliasManager: AliasManager) {
        this.downloadsManager = downloadsManager;
        this.aliasManager = aliasManager;
        logger.info("DownloaderService initialized.");
    }

    /**
     * Asynchronously creates and initializes a DownloaderService.
     */
    public static async create(): Promise<DownloaderService> {
        const downloadsManager = await DownloadsManager.create();
        const aliasManager = await AliasManager.create();
        return new DownloaderService(downloadsManager, aliasManager);
    }

    public async start() {
        logger.info("Starting Downloader Service...");
        await this._loadInitialTokens(); // Wait for the first token load

        // Now start the background watchers
        this._startTokenWatcher();
        this._startStreamWatcher();
        this._startAliasUpdater();
    }

    private async _loadInitialTokens(): Promise<boolean> {
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
                logger.info("Initial tokens loaded successfully.");
                return true;
            } else {
                logger.warn("Initial token load failed: session.json is missing required tokens.");
                this.tokens = null;
                return false;
            }
        } catch (error: any) {
            if (error.code === "ENOENT") {
                logger.warn("Initial token load failed: session.json not found.");
            } else {
                logger.error("Failed to read tokens from session file", { error });
            }
            this.tokens = null;
            return false;
        }
    }

    private async _startTokenWatcher() {
        const refreshInterval = config.getConfig().intervals.shortTokenRefresh;
        // Wait for the initial interval before the first refresh to avoid immediate re-reading
        await timersPromises.setTimeout(refreshInterval);

        while (true) {
            await this._loadInitialTokens(); // Reuse the same logic for refreshing
            await timersPromises.setTimeout(refreshInterval);
        }
    }

    private _startAliasUpdater() {
        const updateAliases = async () => {
            while (!this.tokens) {
                logger.info("Alias updater waiting for tokens...");
                await timersPromises.setTimeout(config.getConfig().intervals.shortTokenRefresh);
            }

            logger.info("Performing hourly alias cache update...");
            try {
                // Step 1: Get all followed account IDs
                const followingsResponse = await requests.getAllFollowing(this.tokens);

                if (!followingsResponse || !followingsResponse.followers || followingsResponse.followers.length === 0) {
                    logger.warn("Alias update failed: Did not receive a valid list of followers from the 'allfollow' endpoint.");
                    return;
                }

                const followers = followingsResponse.followers;
                logger.info(`Step 1/2 SUCCESS: Fetched ${followers.length} followed accounts from 'allfollow' endpoint.`);
                const streamerIds = followers.map((f: any) => f.accountId);

                // Step 2: Get aliases for those IDs in a single batch request
                const batchResponse = await requests.getAliasesInBatch(streamerIds, this.tokens);

                if (!batchResponse) {
                    logger.error("Alias update failed: The POST request to the 'batch' endpoint returned no data.");
                    return;
                }
                logger.info(`Step 2/2 SUCCESS: Received response from 'batch' endpoint.`);

                const aliasMap: { [key: string]: string } = {};
                for (const streamerId in batchResponse) {
                    const alias = batchResponse[streamerId]?.basicProfile?.aliases?.[0]?.alias;
                    if (alias) {
                        aliasMap[streamerId] = alias;
                    }
                }

                if (Object.keys(aliasMap).length > 0) {
                    this.aliasManager.batchSet(aliasMap);
                    logger.info(`Alias cache updated with ${Object.keys(aliasMap).length} entries (out of ${streamerIds.length} IDs sent).`);
                } else {
                    logger.warn("Could not extract any valid aliases from the batch response. Cache not updated.");
                }
            } catch (error) {
                logger.error("An unexpected error occurred during the alias update process.", { error });
            }
        };

        // Fire-and-forget initial update
        updateAliases();

        // Schedule subsequent updates every hour
        setInterval(updateAliases, 60 * 60 * 1000);
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
                                logger.info(`Discovered new stream from ${streamerId}.`);

                                let alias = this.aliasManager.get(streamerId);
                                if (!alias && this.tokens) {
                                    logger.info(`Alias for ${streamerId} not in cache. Fetching from API...`);
                                    alias = await requests.getStreamerAlias(streamerId, this.tokens);
                                    if (alias && alias !== streamerId) {
                                        this.aliasManager.set(streamerId, alias);
                                    }
                                }

                                const downloadHandle = this.downloadsManager.add(masterPlaylistUrl, {
                                    streamerId: streamerId,
                                    alias: alias || streamerId,
                                });

                                if (downloadHandle) {
                                    logger.info(`Initiating download for ${alias || streamerId}...`);
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
        let segmentsDirPath: string | null = null;
        let alias: string;

        try {
            if (!downloadHandle.state) {
                logger.error(`Could not find state for download with handle. Aborting.`);
                return;
            }

            alias = downloadHandle.state.alias;

            if (!this.tokens) throw new Error(`Tokens not available at start of download for ${alias}`);

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
            segmentsDirPath = storage.createDownloadPaths(alias, startDate);

            downloadHandle.update({ segmentsDirPath });

            logger.info(`${segmentsDirPath} started downloading segments.`);

            const downloadedTsUrls: Set<string> = new Set();
            let lastDownload = Date.now();

            while (true) {
                if (!this.tokens) {
                    logger.warn(`Tokens became unavailable for ${segmentsDirPath} mid-stream. Assuming stream has ended.`);
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
                                    logger.error(`Failed to save raw segment for ${segmentsDirPath}`, { error });
                                }
                            }
                        }
                    }
                }

                if (Date.now() - lastDownload > config.getConfig().timeouts.staleStream) {
                    logger.info(`No new segments for ${segmentsDirPath} in ${config.getConfig().timeouts.staleStream / 1000}s. Assuming stream has ended.`);
                    break;
                }
                await timersPromises.setTimeout(1000);
            }
        } catch (error) {
            logger.error(`Download process for ${segmentsDirPath} failed fatally.`, { error });
        } finally {
            logger.info(`Finished download process for: ${segmentsDirPath}`);
            downloadHandle.remove();
        }
    }

    private async _getLiveUrlFromMaster(downloadHandle: DownloadHandle): Promise<string | null> {
        if (!this.tokens) return null;
        try {
            const masterListBody = await requests.getMasterList(downloadHandle.masterPlaylistUrl, this.tokens);
            if (!masterListBody) {
                logger.warn(`Could not fetch master playlist body from: ${downloadHandle.masterPlaylistUrl} for ${downloadHandle.state?.segmentsDirPath}`);
                return null;
            }

            const masterLines = masterListBody.split("\n").filter((line) => line.trim() !== "");
            let relativeLiveUrl;
            for (let i = 0; i < masterLines.length; i++) {
                if (masterLines[i].includes("RESOLUTION=1280x720")) {
                    relativeLiveUrl = masterLines[i + 1];
                    break;
                }
            }

            if (!relativeLiveUrl) {
                logger.warn(`Could not find HD stream in master playlist: ${downloadHandle.masterPlaylistUrl} for ${downloadHandle.state?.segmentsDirPath}`);
                return null;
            }
            const cinemaApiUrl = downloadHandle.masterPlaylistUrl.split("/v2/")[0];
            let livePlaylistUrl = `${cinemaApiUrl}${relativeLiveUrl}`;
            if (livePlaylistUrl.endsWith("&")) {
                livePlaylistUrl = livePlaylistUrl.substring(0, livePlaylistUrl.length - 1);
            }
            return livePlaylistUrl;
        } catch (error) {
            logger.error(`Error resolving live URL from master: ${downloadHandle.masterPlaylistUrl} for ${downloadHandle.state?.segmentsDirPath}`, { error });
            return null;
        }
    }
}
