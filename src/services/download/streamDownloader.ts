// src/downloader/streamDownloader.ts
import * as timersPromises from "timers/promises";
import * as path from "path";

import * as config from "../../common/config.js";
import logger from "../../common/logger.js";
import { DownloadPathManager } from "./downloadPathManager.js";
import { ApiClient } from "../api/apiClient.js";
import { DownloadHandle } from "../state/downloadsManager.js";
import { FileSystemManager } from "../../common/fileSystemManager.js";
import { PlaylistManager } from "./playlistManager.js";

export class StreamDownloader {
    private downloadHandle: DownloadHandle;
    private apiClient: ApiClient;

    constructor(downloadHandle: DownloadHandle, apiClient: ApiClient) {
        this.downloadHandle = downloadHandle;
        this.apiClient = apiClient;
    }

    public async start() {
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
        const segmentsDirPath = await DownloadPathManager.createDownloadPaths(alias, startDate);

        if (!segmentsDirPath) {
            logger.error(`Failed to create download paths for ${alias}. Aborting download.`);
            this.downloadHandle.remove();
            return;
        }

        this.downloadHandle.update({ segmentsDirPath });
        logger.info(`${segmentsDirPath} started downloading segments.`);

        const playlistManager = new PlaylistManager(segmentsDirPath);
        let lastDownload = Date.now();

        while (Date.now() - lastDownload < config.getConfig().timeouts.staleStream) {
            const liveResponse = await this.apiClient.getLiveList(liveUrl);

            if (liveResponse.success && liveResponse.data) {
                const cinemaApiUrl = this.downloadHandle.masterPlaylistUrl.split("/v2/")[0];
                const segmentsToDownload = await playlistManager.processLivePlaylist(liveResponse.data, cinemaApiUrl);

                if (segmentsToDownload.length > 0) {
                    for (const segment of segmentsToDownload) {
                        const tsBuffer = await this.apiClient.getTsSegment(segment.remoteUrl);
                        if (tsBuffer) {
                            const segmentPath = path.join(segmentsDirPath, segment.localName);
                            const success = await FileSystemManager.writeFile(segmentPath, tsBuffer as unknown as Uint8Array);
                            if (success) {
                                lastDownload = Date.now();
                            }
                        }
                    }
                }
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
