import * as timersPromises from "timers/promises";
import * as path from "path";
import * as fs from "fs/promises";

import * as config from "../../common/config.js";
import logger from "../../common/logger.js";
import { DownloadHandle } from "../state/downloadsManager.js";
import { FileSystemManager } from "../../common/fileSystemManager.js";
import { PlaylistManager } from "./playlistManager.js";
import { IDownloadSession, IStreamProvider } from "../core/interfaces.js";
import { StreamQualityMonitor } from "./streamQualityMonitor.js";
export type DownloadExitReason = "completed" | "aborted" | "error";

export interface DownloadResult {
    exitReason: DownloadExitReason;
    segmentCount: number;
}

export class StreamDownloader {
    private downloadHandle: DownloadHandle;
    private streamProvider: IStreamProvider;
    private aborted = false;
    private downloadSession: IDownloadSession;
    private initSegmentDownloaded = false;
    private initCounter = 0;
    private currentInitName = "init.mp4";
    private pendingUpgrade: string | null = null;

    constructor(downloadHandle: DownloadHandle, streamProvider: IStreamProvider) {
        this.downloadHandle = downloadHandle;
        this.streamProvider = streamProvider;
        this.downloadSession = streamProvider.createDownloadSession();
    }

    public abort(): void {
        this.aborted = true;
    }

    public async start(): Promise<DownloadResult> {
        if (!this.downloadHandle.state) {
            logger.error(`Could not find state for download with handle. Aborting.`);
            this.downloadHandle.remove();
            return { exitReason: "error", segmentCount: 0 };
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
            logger.info(`[SC-DEBUG] EARLY-EXIT ${alias} reason=parseMasterPlaylist-failed`);
            this.downloadHandle.remove();
            return { exitReason: "error", segmentCount: 0 };
        }

        this.downloadHandle.update({ liveUrl });

        const startDate = new Date();
        const segmentsDirPath = await this.streamProvider.setupDownloadDir(alias, startDate);

        if (!segmentsDirPath) {
            logger.info(`[SC-DEBUG] EARLY-EXIT ${alias} reason=setupDownloadDir-failed`);
            this.downloadHandle.remove();
            return { exitReason: "error", segmentCount: 0 };
        }

        this.downloadHandle.update({ segmentsDirPath });
        logger.info(`[SC-DEBUG] START ${alias} dir=${path.basename(segmentsDirPath)} url=${this.downloadHandle.masterPlaylistUrl}`);

        const playlistManager = new PlaylistManager(segmentsDirPath);

        const qualityMonitor = new StreamQualityMonitor(
            this.streamProvider,
            this.downloadHandle.masterPlaylistUrl,
            liveUrl,
            async (newUrl) => {
                this.pendingUpgrade = newUrl;
            },
            10000
        );
        qualityMonitor.start();

        let lastDownload = Date.now();
        let consecutiveFailures = 0;
        let segmentCount = 0;
        let lastHeartbeat = Date.now();
        const HEARTBEAT_INTERVAL = 30000;

        while (!this.aborted && Date.now() - lastDownload < config.getConfig().timeouts.staleStream) {
            if (this.pendingUpgrade) {
                this.initCounter++;
                this.currentInitName = `init_${this.initCounter}.mp4`;
                logger.info(`[StreamDownloader] Quality upgrade for ${alias} — new init: ${this.currentInitName}`);
                await playlistManager.insertQualityChange(this.currentInitName);
                liveUrl = this.pendingUpgrade;
                this.downloadHandle.update({ liveUrl });
                qualityMonitor.updateCurrentUrl(liveUrl);
                this.initSegmentDownloaded = false;
                this.pendingUpgrade = null;
                if (segmentCount > 0) lastDownload = Date.now();
                consecutiveFailures = 0;
            }

            if (Date.now() - lastHeartbeat > HEARTBEAT_INTERVAL) {
                const staleSec = ((Date.now() - lastDownload) / 1000).toFixed(0);
                logger.info(`[SC-DEBUG] HEARTBEAT ${alias} segments=${segmentCount} staleSec=${staleSec} failures=${consecutiveFailures}`);
                lastHeartbeat = Date.now();
            }

            const liveResponse = await this.downloadSession.getLiveList(liveUrl);

            if (liveResponse.success && liveResponse.data) {
                consecutiveFailures = 0;

                if (!this.initSegmentDownloaded) {
                    const mapMatch = liveResponse.data.match(/#EXT-X-MAP:URI="([^"]+)"/);
                    if (mapMatch) {
                        const initUrl = this.streamProvider.getSegmentUrl(liveUrl!, mapMatch[1]);
                        const initBuffer = await this.downloadSession.getTsSegment(initUrl);
                        if (initBuffer) {
                            const initPath = path.join(segmentsDirPath, this.currentInitName);
                            await FileSystemManager.writeFile(initPath, initBuffer as unknown as Uint8Array);
                            logger.info(`[StreamDownloader] Downloaded init segment for ${alias}`);
                        }
                    }
                    this.initSegmentDownloaded = true;
                }

                const segmentsToProcess = await playlistManager.identifyNewSegments(
                    liveResponse.data,
                    (line) => this.streamProvider.getSegmentUrl(liveUrl!, line)
                );

                if (segmentsToProcess.length > 0) {
                    for (const segment of segmentsToProcess) {
                        const tsBuffer = await this.downloadSession.getTsSegment(segment.remoteUrl);

                        const baseName = segment.localName.replace(/\.\w+$/, "");
                        if (!/^\d+$/.test(baseName)) {
                            segment.localName = `${playlistManager.startSequence + segmentCount}.ts`;
                        }

                        const segmentPath = path.join(segmentsDirPath, segment.localName);

                        if (!tsBuffer) {
                            logger.info(`[SC-DEBUG] NULL-SEGMENT ${alias} segment=${segment.localName}`);
                            break;
                        }

                        const writeSuccess = await FileSystemManager.writeFile(segmentPath, tsBuffer as unknown as Uint8Array);

                        if (writeSuccess) {
                            const result = await this.streamProvider.validateSegment(segmentPath);

                            if (!result.valid) {
                                await fs.unlink(segmentPath).catch(() => {});
                                playlistManager.addIgnoredSegment(segment.localName);
                                lastDownload = Date.now();
                            } else {
                                if (result.duration !== undefined) {
                                    segment.accurateDuration = result.duration;
                                }
                                await playlistManager.appendSegmentToPlaylist(segment);
                                lastDownload = Date.now();
                                segmentCount++;
                            }
                        } else {
                            logger.error(`Failed to write segment to disk, pausing processing:`, { segmentPath });
                            break;
                        }
                    }
                }
            } else {
                consecutiveFailures++;
            }
            await timersPromises.setTimeout(1000);
        }

        let exitReason: DownloadExitReason;
        if (this.aborted) {
            exitReason = "aborted";
        } else if (segmentCount > 0) {
            exitReason = "completed";
        } else {
            exitReason = "error";
        }

        const staleSec = ((Date.now() - lastDownload) / 1000).toFixed(0);
        logger.info(`[SC-DEBUG] LOOP-EXIT ${alias} reason=${exitReason} staleSec=${staleSec} segments=${segmentCount} dir=${path.basename(segmentsDirPath)}`);

        qualityMonitor.stop();
        await playlistManager.finalizePlaylist();

        logger.info(`[SC-DEBUG] HANDLE-REMOVE ${alias} dir=${path.basename(segmentsDirPath)} url=${this.downloadHandle.masterPlaylistUrl}`);
        this.downloadHandle.remove();

        return { exitReason, segmentCount };
    }
}