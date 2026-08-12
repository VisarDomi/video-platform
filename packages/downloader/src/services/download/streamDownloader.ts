import * as timersPromises from "timers/promises";
import * as path from "path";
import * as fs from "fs/promises";

import logger from "../../common/logger.js";
import { DownloadHandle } from "../state/downloadsManager.js";
import { FileSystemManager } from "../../common/fileSystemManager.js";
import type { PlaylistManager } from "./playlistManager.js";
import type { InitTracker } from "./initTracker.js";
import type { DiskSession } from "./diskSession.js";
import { IDownloadSession, IStreamProvider } from "../core/interfaces.js";
import { resolveSegmentUrl } from "../core/downloadUtils.js";
import { STALE_STREAM_TIMEOUT_MS, QUALITY_CHECK_INTERVAL_MS, HEARTBEAT_INTERVAL_MS, NO_NEW_SEGMENTS_SLEEP_MS, INIT_RETRY_SLEEP_MS, EDGE_RECOVERY_SLEEP_MS, CDN_FETCH_TIMEOUT_MS } from "../../common/timing.js";

export type ExitReason = "aborted" | "remote-endlist" | "segment-failed" | "stale-timeout" | "fetch-failed";

export interface DownloadResult {
    segmentCount: number;
    aborted: boolean;
    exitReason: ExitReason;
    lastLiveUrl: string | null;
}

export class StreamDownloader {
    private handle: DownloadHandle;
    private provider: IStreamProvider;
    private _aborted = false;
    private rejectedCount = 0;

    constructor(handle: DownloadHandle, provider: IStreamProvider) {
        this.handle = handle;
        this.provider = provider;
    }

    public abort(): void {
        this._aborted = true;
    }

    public async run(
        masterUrl: string,
        playlistManager: PlaylistManager,
        initTracker: InitTracker,
        disk: DiskSession,
    ): Promise<DownloadResult> {
        const alias = this.handle.state?.alias ?? "unknown";
        const liveUrl = await this.provider.parseMasterPlaylist(masterUrl);

        if (!liveUrl) {
            logger.info(`[StreamDownloader] EARLY-EXIT ${alias} reason=parseMasterPlaylist-failed`);
            return { segmentCount: 0, aborted: false, exitReason: "fetch-failed", lastLiveUrl: null };
        }

        this.handle.update({ liveUrl });

        const edgeMatch = liveUrl.match(/\/(b-hls-\d+)\//);
        const edge = edgeMatch ? edgeMatch[1] : "unknown";
        logger.info(`[StreamDownloader] START ${alias} edge=${edge} variant=${liveUrl.split("?")[0]}`);

        let session = this.provider.createDownloadSession();
        playlistManager.setEdge(liveUrl);

        return await this.downloadLoop(alias, masterUrl, liveUrl, session, playlistManager, initTracker, disk);
    }

    private async checkForQualityUpgrade(
        alias: string,
        masterUrl: string,
        currentLiveUrl: string,
    ): Promise<string | null> {
        const betterUrl = await this.provider.parseMasterPlaylist(masterUrl);
        if (!betterUrl) {
            logger.debug(`[StreamDownloader] ${alias} quality check: master playlist unavailable`);
            return null;
        }

        const normalize = (url: string) =>
            url.split("?")[0].replace(/doppiocdn\.(org|com|net)/g, "doppiocdn._");

        if (normalize(betterUrl) === normalize(currentLiveUrl)) {
            logger.debug(`[StreamDownloader] ${alias} quality check: no change`);
            return null;
        }
        return betterUrl;
    }

    private async downloadLoop(
        alias: string,
        masterUrl: string,
        initialLiveUrl: string,
        initialSession: IDownloadSession,
        playlistManager: PlaylistManager,
        initTracker: InitTracker,
        disk: DiskSession,
    ): Promise<DownloadResult> {
        let liveUrl = initialLiveUrl;
        let session = initialSession;
        let lastDownload = Date.now();
        let segmentFailed = false;
        let remoteEndlist = false;
        let health: 'ok' | 'stale' = 'ok';
        let lastQualityCheck = Date.now();
        const staleTimeout = STALE_STREAM_TIMEOUT_MS;

        while (!this._aborted && Date.now() - lastDownload < staleTimeout) {
            if (health === 'ok' && Date.now() - lastDownload > HEARTBEAT_INTERVAL_MS) {
                health = 'stale';
                const staleSec = ((Date.now() - lastDownload) / 1000).toFixed(0);
                logger.warn(`[StreamDownloader] STALE ${alias} segments=${initTracker.count} staleSec=${staleSec}`);
            }

            if (Date.now() - lastQualityCheck > QUALITY_CHECK_INTERVAL_MS) {
                lastQualityCheck = Date.now();
                const betterUrl = await this.checkForQualityUpgrade(alias, masterUrl, liveUrl);
                if (betterUrl) {
                    logger.info(`[StreamDownloader] Quality upgrade for ${alias}: ${betterUrl.split("?")[0]}`);
                    liveUrl = betterUrl;
                    this.handle.update({ liveUrl });
                }
            }

            let content = await session.fetchPlaylist(liveUrl);
            if (!content) {
                const recovered = await this.provider.recoverVariant(this.handle.masterPlaylistUrl);
                if (!recovered) {
                    logger.info(`[StreamDownloader] ${alias} variant failed, no recovery available (segments=${initTracker.count} url=${liveUrl})`);
                    await timersPromises.setTimeout(EDGE_RECOVERY_SLEEP_MS);
                    continue;
                }

                const oldEdge = playlistManager.timeline.edge;
                const newEdgeMatch = recovered.match(/\/(b-hls-\d+)\//);
                const newEdge = newEdgeMatch ? newEdgeMatch[1] : null;

                if (newEdge && newEdge !== oldEdge) {
                    playlistManager.setEdge(recovered);
                    playlistManager.onEdgeSwitch(oldEdge, newEdge);
                    logger.info(`[StreamDownloader] ${alias} EDGE-SWITCH ${oldEdge ?? "none"} → ${newEdge} variant=${recovered.split("?")[0]}`);
                } else {
                    logger.info(`[StreamDownloader] ${alias} variant recovered (same edge) variant=${recovered.split("?")[0]}`);
                }

                liveUrl = recovered;
                this.handle.update({ liveUrl });
                session = this.provider.createDownloadSession();

                content = await session.fetchPlaylist(liveUrl);
                if (!content) {
                    logger.warn(`[StreamDownloader] ${alias} recovered variant also failed — retrying`);
                    await timersPromises.setTimeout(EDGE_RECOVERY_SLEEP_MS);
                    continue;
                }
            }

            const mapMatch = content.match(/#EXT-X-MAP:URI="([^"]+)"/);
            if (mapMatch) {
                const mapUri = mapMatch[1];
                if (initTracker.needsUpdate(mapUri)) {
                    const initUrl = resolveSegmentUrl(liveUrl, mapUri);
                    const result = await initTracker.commitInit(
                        mapUri,
                        () => session.fetchSegment(initUrl),
                        playlistManager.nextSegmentNumber,
                    );

                    if (!result) {
                        logger.warn(`[StreamDownloader] ${alias} init segment failed — retrying`);
                        await timersPromises.setTimeout(INIT_RETRY_SLEEP_MS);
                        continue;
                    }

                    if (result.isQualityChange) {
                        playlistManager.bufferQualityChange(result.fileName);
                    }

                    logger.info(`[StreamDownloader] Downloaded init segment for ${alias} (${result.fileName})`);
                }
            }

            const segments = await playlistManager.identifyNewSegments(
                content,
                (line) => resolveSegmentUrl(liveUrl, line),
            );

            let downloadedThisIteration = false;

            for (const segment of segments) {
                if (playlistManager.shouldSkipByTimeline(segment)) {
                    continue;
                }

                const fetchResult = await session.fetchSegment(segment.remoteUrl);

                if (!fetchResult.data) {
                    if (fetchResult.retryable) {
                        logger.warn(`[StreamDownloader] ${alias} segment skipped segment=${segment.localName}`);
                        playlistManager.addIgnoredSegment(segment.identityKey);
                        continue;
                    }
                    logger.warn(`[StreamDownloader] ${alias} segment download failed segment=${segment.localName} url=${segment.remoteUrl} — stopping`);
                    segmentFailed = true;
                    break;
                }
                const tsBuffer = fetchResult.data;

                if (!await disk.materialize()) {
                    logger.error(`[StreamDownloader] ${alias} disk materialization failed — stopping`);
                    segmentFailed = true;
                    break;
                }

                const segmentPath = path.join(disk.dirPath, segment.localName);
                const writeSuccess = await FileSystemManager.writeFileExclusive(segmentPath, tsBuffer as unknown as Uint8Array);
                if (!writeSuccess) {
                    logger.error(`[StreamDownloader] ${alias} disk write failed segment=${segmentPath} — stopping`);
                    segmentFailed = true;
                    break;
                }

                const result = await this.provider.validateSegment(segmentPath);
                if (!result.valid) {
                    await fs.unlink(segmentPath).catch(() => {});
                    playlistManager.addIgnoredSegment(segment.identityKey);
                    this.rejectedCount++;
                } else {
                    if (result.duration !== undefined) {
                        segment.accurateDuration = result.duration;
                    }
                    await playlistManager.appendSegmentToPlaylist(segment);
                    playlistManager.recordDownloadedPDT(segment.programDateTime);
                    if (health === 'stale') {
                        health = 'ok';
                        const staleSec = ((Date.now() - lastDownload) / 1000).toFixed(0);
                        logger.info(`[StreamDownloader] RECOVERED ${alias} segments=${initTracker.count} staleSec=${staleSec}`);
                    }
                    lastDownload = Date.now();
                    initTracker.incrementSegmentCount();
                    downloadedThisIteration = true;
                }
            }

            if (segmentFailed) break;

            if (content.split(/\r?\n/).some((line) => line.trim() === "#EXT-X-ENDLIST")) {
                remoteEndlist = true;
                logger.info(`[StreamDownloader] ${alias}: upstream playlist supplied ENDLIST`);
                break;
            }

            if (!downloadedThisIteration) {
                await timersPromises.setTimeout(NO_NEW_SEGMENTS_SLEEP_MS);
            }
        }

        const staleSec = ((Date.now() - lastDownload) / 1000).toFixed(0);
        const staleTimedOut = Date.now() - lastDownload >= staleTimeout;
        let exitReason: ExitReason;
        if (this._aborted) {
            exitReason = "aborted";
        } else if (remoteEndlist) {
            exitReason = "remote-endlist";
        } else if (segmentFailed) {
            exitReason = "segment-failed";
        } else if (staleTimedOut) {
            exitReason = "stale-timeout";
        } else {
            exitReason = "fetch-failed";
        }
        const timeline = playlistManager.timeline;
        const timelineDetails = timeline.edge
            ? ` edge=${timeline.edge} seq=${timeline.mediaSequence} firstPDT=${timeline.firstProgramDateTime ?? "none"} lastPDT=${timeline.lastProgramDateTime ?? "none"}`
            : "";
        const rejStr = this.rejectedCount > 0 ? ` rejected=${this.rejectedCount}` : "";
        logger.info(`[StreamDownloader] LOOP-EXIT ${alias} reason=${exitReason} staleSec=${staleSec} segments=${initTracker.count}${rejStr}${disk.materialized ? ` dir=${path.basename(disk.dirPath)}` : ""}${timelineDetails}`);

        return { segmentCount: initTracker.count, aborted: this._aborted, exitReason, lastLiveUrl: liveUrl };
    }
}
