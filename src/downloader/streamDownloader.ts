// src/downloader/streamDownloader.ts
import * as fsPromises from "fs/promises";
import * as timersPromises from "timers/promises";
import * as path from "path";

import * as config from "../common/config.js";
import logger from "../common/logger.js";
import * as storage from "../common/storage.js";
import * as requests from "./requests.js";
import { DownloadHandle } from "./downloadsManager.js";

export class StreamDownloader {
    private downloadHandle: DownloadHandle;

    constructor(downloadHandle: DownloadHandle) {
        this.downloadHandle = downloadHandle;
    }

    public async start() {
        let segmentsDirPath: string | null = null;
        let alias: string;

        try {
            if (!this.downloadHandle.state) {
                logger.error(`Could not find state for download with handle. Aborting.`);
                return;
            }

            alias = this.downloadHandle.state.alias;

            let liveUrl: string | null = null;
            const MAX_RETRIES = 3;
            const RETRY_DELAY = 5000;

            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                const resolvedUrl = await this._getLiveUrlFromMaster();
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

            this.downloadHandle.update({ liveUrl });

            const startDate = new Date();
            segmentsDirPath = storage.createDownloadPaths(alias, startDate);

            this.downloadHandle.update({ segmentsDirPath });

            logger.info(`${segmentsDirPath} started downloading segments.`);

            const downloadedTsUrls: Set<string> = new Set();
            let lastDownload = Date.now();

            while (true) {
                const liveResponse = await requests.getLiveList(liveUrl);

                if (liveResponse.success && liveResponse.data) {
                    const liveLines = liveResponse.data.split("\n").filter((line) => line.trim() !== "");
                    const cinemaApiUrl = this.downloadHandle.masterPlaylistUrl.split("/v2/")[0];

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
            logger.error(`Download process for ${segmentsDirPath || this.downloadHandle.state?.alias} failed fatally.`, { error });
        } finally {
            logger.info(`Finished download process for: ${segmentsDirPath || this.downloadHandle.state?.alias}`);
            this.downloadHandle.remove();
        }
    }

    private async _getLiveUrlFromMaster(): Promise<string | null> {
        try {
            const masterListBody = await requests.getMasterList(this.downloadHandle.masterPlaylistUrl);
            if (!masterListBody) {
                logger.warn(
                    `Could not fetch master playlist body from: ${this.downloadHandle.masterPlaylistUrl} for ${this.downloadHandle.state?.segmentsDirPath}`
                );
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
                logger.warn(
                    `Could not find HD stream in master playlist: ${this.downloadHandle.masterPlaylistUrl} for ${this.downloadHandle.state?.segmentsDirPath}`
                );
                return null;
            }
            const cinemaApiUrl = this.downloadHandle.masterPlaylistUrl.split("/v2/")[0];
            let livePlaylistUrl = `${cinemaApiUrl}${relativeLiveUrl}`;
            if (livePlaylistUrl.endsWith("&")) {
                livePlaylistUrl = livePlaylistUrl.substring(0, livePlaylistUrl.length - 1);
            }
            return livePlaylistUrl;
        } catch (error) {
            logger.error(`Error resolving live URL from master: ${this.downloadHandle.masterPlaylistUrl} for ${this.downloadHandle.state?.segmentsDirPath}`, {
                error,
            });
            return null;
        }
    }
}
