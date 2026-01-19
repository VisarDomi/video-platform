import * as timersPromises from "timers/promises";
import * as path from "path";
import * as fs from "fs/promises";

import * as config from "../../common/config.js";
import logger from "../../common/logger.js";
import { DownloadPathManager } from "./tango/downloadPathManager.js";
import { DownloadHandle } from "../state/downloadsManager.js";
import { FileSystemManager } from "../../common/fileSystemManager.js";
import { PlaylistManager } from "./playlistManager.js";
import { MediaValidator } from "../../common/mediaValidator.js";
import { IStreamProvider } from "../core/interfaces.js";

export class StreamDownloader {
    private downloadHandle: DownloadHandle;
    private streamProvider: IStreamProvider;

    constructor(downloadHandle: DownloadHandle, streamProvider: IStreamProvider) {
        this.downloadHandle = downloadHandle;
        this.streamProvider = streamProvider;
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
            const liveResponse = await this.streamProvider.getLiveList(liveUrl);

            if (liveResponse.success && liveResponse.data) {
                const cinemaApiUrl = this.downloadHandle.masterPlaylistUrl.split("/v2/")[0];
                const segmentsToProcess = await playlistManager.identifyNewSegments(liveResponse.data, cinemaApiUrl);

                if (segmentsToProcess.length > 0) {
                    for (const segment of segmentsToProcess) {
                        const tsBuffer = await this.streamProvider.getTsSegment(segment.remoteUrl);
                        const segmentPath = path.join(segmentsDirPath, segment.localName);

                        if (!tsBuffer) {
                            logger.warn(`Pausing segment processing due to download failure:`, { segmentPath });
                            break;
                        }

                        const writeSuccess = await FileSystemManager.writeFile(segmentPath, tsBuffer as unknown as Uint8Array);

                        if (writeSuccess) {
                            // Validate using shared MediaValidator
                            const isBad = await MediaValidator.isSegmentCorrupt(segmentPath);

                            if (isBad) {
                                logger.warn(`Downloaded segment is corrupt (0kb/s or bad duration). Deleting and skipping: ${segmentPath}`);
                                await fs.unlink(segmentPath).catch(() => {});
                                playlistManager.addIgnoredSegment(segment.localName);
                                // Keep lastDownload fresh so we don't abort stream due to bad segments
                                lastDownload = Date.now();
                            } else {
                                await playlistManager.appendSegmentToPlaylist(segment);
                                lastDownload = Date.now();
                            }
                        } else {
                            logger.error(`Failed to write segment to disk, pausing processing:`, { segmentPath });
                            break;
                        }
                    }
                }
            }

            await timersPromises.setTimeout(1000);
        }

        await playlistManager.finalizePlaylist();

        logger.info(`Finished download process for: ${segmentsDirPath}`);
        this.downloadHandle.remove();
    }

    private async _getLiveUrlFromMaster(): Promise<string | null> {
        const masterListBody = await this.streamProvider.getMasterList(this.downloadHandle.masterPlaylistUrl);
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