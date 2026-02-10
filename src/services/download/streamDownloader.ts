import * as timersPromises from "timers/promises";
import * as path from "path";
import * as fs from "fs/promises";

import * as config from "../../common/config.js";
import logger from "../../common/logger.js";
import { DownloadHandle } from "../state/downloadsManager.js";
import { FileSystemManager } from "../../common/fileSystemManager.js";
import { PlaylistManager } from "./playlistManager.js";
import { IStreamProvider } from "../core/interfaces.js";
import { StreamQualityMonitor } from "./streamQualityMonitor.js";
// Needed for type checking/casting if we want to call ScClient methods
import { ScClient } from "../sc/api/scClient.js";

export class StreamDownloader {
    private downloadHandle: DownloadHandle;
    private streamProvider: IStreamProvider;
    private aborted = false;

    constructor(downloadHandle: DownloadHandle, streamProvider: IStreamProvider) {
        this.downloadHandle = downloadHandle;
        this.streamProvider = streamProvider;
    }

    public abort(): void {
        this.aborted = true;
    }

    public get isAborted(): boolean {
        return this.aborted;
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
            const resolvedUrl = await this.streamProvider.parseMasterPlaylist(this.downloadHandle.masterPlaylistUrl);
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
        const segmentsDirPath = await this.streamProvider.setupDownloadDir(alias, startDate);

        if (!segmentsDirPath) {
            logger.error(`Failed to create download paths for ${alias}. Aborting download.`);
            this.downloadHandle.remove();
            return;
        }

        this.downloadHandle.update({ segmentsDirPath });
        logger.info(`${segmentsDirPath} started downloading segments.`);

        const playlistManager = new PlaylistManager(segmentsDirPath);

        const qualityMonitor = new StreamQualityMonitor(
            this.streamProvider,
            this.downloadHandle.masterPlaylistUrl,
            liveUrl,
            async (newUrl) => {
                logger.info(`[StreamDownloader] Switching quality for ${alias}`);
                await playlistManager.insertDiscontinuity();
                liveUrl = newUrl;
                this.downloadHandle.update({ liveUrl });
            },
            10000
        );
        qualityMonitor.start();

        let lastDownload = Date.now();

        while (!this.aborted && Date.now() - lastDownload < config.getConfig().timeouts.staleStream) {
            const liveResponse = await this.streamProvider.getLiveList(liveUrl);

            if (liveResponse.success && liveResponse.data) {
                const segmentsToProcess = await playlistManager.identifyNewSegments(
                    liveResponse.data,
                    (line) => this.streamProvider.getSegmentUrl(liveUrl!, line)
                );

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
                            const isValid = await this.streamProvider.validateSegment(segmentPath);

                            if (!isValid) {
                                await fs.unlink(segmentPath).catch(() => {});
                                playlistManager.addIgnoredSegment(segment.localName);
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

        qualityMonitor.stop();
        await playlistManager.finalizePlaylist();

        logger.info(`Finished download process for: ${segmentsDirPath}`);

        // --- CLEANUP SC SESSION ON DOWNLOAD END ---
        if (this.streamProvider instanceof ScClient) {
            const match = this.downloadHandle.masterPlaylistUrl.match(/synthetic-sc\/([^\/]+)\//);
            const channelId = match ? match[1] : this.downloadHandle.state.streamerId;
            if (channelId) {
                logger.info(`[StreamDownloader] Closing SC session for ${channelId}`);
                await (this.streamProvider as ScClient).forceCloseSession(channelId);
            }
        }
        // ------------------------------------------

        this.downloadHandle.remove();
    }
}