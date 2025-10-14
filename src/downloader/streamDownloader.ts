// src/downloader/streamDownloader.ts
import * as timersPromises from "timers/promises";
import * as path from "path";

import * as config from "../common/config.js";
import logger from "../common/logger.js";
import { DownloadPathManager } from "./downloadPathManager.js";
import { ApiClient } from "./apiClient.js";
import { DownloadHandle } from "./downloadsManager.js";
import { FileSystemManager } from "./fileSystemManager.js";

export class StreamDownloader {
    private downloadHandle: DownloadHandle;
    private apiClient: ApiClient;

    constructor(downloadHandle: DownloadHandle, apiClient: ApiClient) {
        this.downloadHandle = downloadHandle;
        this.apiClient = apiClient;
    }

    public async start() {
        let segmentsDirPath: string | null = null;

        if (!this.downloadHandle.state) {
            logger.error(`Could not find state for download with handle. Aborting.`);
            return;
        }

        const alias = this.downloadHandle.state.alias;

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
            logger.error(`Could not resolve live playlist URL for ${alias} after ${MAX_RETRIES} attempts. Aborting download.`);
            this.downloadHandle.remove();
            return;
        }

        this.downloadHandle.update({ liveUrl });

        const startDate = new Date();
        segmentsDirPath = await DownloadPathManager.createDownloadPaths(alias, startDate);

        if (!segmentsDirPath) {
            logger.error(`Failed to create download paths for ${alias}. Aborting download.`);
            this.downloadHandle.remove();
            return;
        }

        this.downloadHandle.update({ segmentsDirPath });

        logger.info(`${segmentsDirPath} started downloading segments.`);

        const downloadedTsUrls: Set<string> = new Set();
        let lastDownload = Date.now();

        while (true) {
            const liveResponse = await this.apiClient.getLiveList(liveUrl);

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
                        const tsBuffer = await this.apiClient.getTsSegment(tsUrl);
                        if (tsBuffer) {
                            const tsNameHls = tsUrl.substring(tsUrl.lastIndexOf("/") + 1);
                            const tsName = tsNameHls.substring(0, tsNameHls.lastIndexOf("?"));
                            const segmentPath = path.join(segmentsDirPath, tsName);
                            const success = await FileSystemManager.writeFile(segmentPath, tsBuffer as unknown as Uint8Array);
                            if (success) {
                                lastDownload = Date.now();
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

        logger.info(`Finished download process for: ${segmentsDirPath}`);
        this.downloadHandle.remove();
    }

    private async _getLiveUrlFromMaster(): Promise<string | null> {
        const masterListBody = await this.apiClient.getMasterList(this.downloadHandle.masterPlaylistUrl);
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
    }
}
