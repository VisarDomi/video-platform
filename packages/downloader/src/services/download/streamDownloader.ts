import * as timersPromises from "timers/promises";
import * as path from "path";
import * as fs from "fs/promises";

import * as config from "../../common/config.js";
import logger from "../../common/logger.js";
import { DownloadHandle } from "../state/downloadsManager.js";
import { FileSystemManager } from "../../common/fileSystemManager.js";
import { PlaylistManager } from "./playlistManager.js";
import { IDownloadSession, IStreamProvider } from "../core/interfaces.js";

export interface DownloadResult {
    segmentCount: number;
    aborted: boolean;
}

const HEARTBEAT_INTERVAL = 30_000;
const QUALITY_CHECK_INTERVAL = 10_000;

export class StreamDownloader {
    private handle: DownloadHandle;
    private provider: IStreamProvider;
    private _aborted = false;

    constructor(handle: DownloadHandle, provider: IStreamProvider) {
        this.handle = handle;
        this.provider = provider;
    }

    public abort(): void {
        this._aborted = true;
    }

    public async start(): Promise<DownloadResult> {
        if (!this.handle.state) {
            logger.error(`Could not find state for download with handle. Aborting.`);
            this.handle.remove();
            return { segmentCount: 0, aborted: false };
        }

        const alias = this.handle.state.alias;
        const liveUrl = await this.provider.parseMasterPlaylist(this.handle.masterPlaylistUrl);

        if (!liveUrl) {
            logger.info(`[StreamDownloader] EARLY-EXIT ${alias} reason=parseMasterPlaylist-failed`);
            this.handle.remove();
            return { segmentCount: 0, aborted: false };
        }

        this.handle.update({ liveUrl });

        const segmentsDirPath = await this.provider.setupDownloadDir(alias, new Date());
        if (!segmentsDirPath) {
            logger.info(`[StreamDownloader] EARLY-EXIT ${alias} reason=setupDownloadDir-failed`);
            this.handle.remove();
            return { segmentCount: 0, aborted: false };
        }

        this.handle.update({ segmentsDirPath });
        logger.info(`[StreamDownloader] START ${alias} dir=${path.basename(segmentsDirPath)} master=${this.handle.masterPlaylistUrl} variant=${liveUrl.split("?")[0]}`);

        const session = this.provider.createDownloadSession();
        const playlistManager = new PlaylistManager(segmentsDirPath);

        const result = await this.downloadLoop(alias, liveUrl, segmentsDirPath, session, playlistManager);

        await playlistManager.finalizePlaylist();

        logger.info(`[StreamDownloader] HANDLE-REMOVE ${alias} dir=${path.basename(segmentsDirPath)} url=${this.handle.masterPlaylistUrl}`);
        this.handle.remove();

        return result;
    }

    /**
     * Check if a better quality variant is available by re-parsing the master
     * playlist.  Called inline by the download loop — no concurrent timer,
     * no shared mutable state.  The download loop is the sole owner of liveUrl.
     */
    private async checkForQualityUpgrade(
        alias: string,
        currentLiveUrl: string,
    ): Promise<string | null> {
        const betterUrl = await this.provider.parseMasterPlaylist(this.handle.masterPlaylistUrl);
        if (!betterUrl) {
            logger.debug(`[StreamDownloader] ${alias} quality check: master playlist unavailable`);
            return null;
        }

        // Compare ignoring query params and CDN TLD differences
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
        initialLiveUrl: string,
        segmentsDirPath: string,
        session: IDownloadSession,
        playlistManager: PlaylistManager,
    ): Promise<DownloadResult> {
        // All download state is local. No class fields, no concurrent mutation.
        let liveUrl = initialLiveUrl;
        let lastDownload = Date.now();
        let segmentCount = 0;
        let segmentFailed = false;
        let lastHeartbeat = Date.now();
        let lastQualityCheck = Date.now();
        let currentMapUri: string | null = null;
        let initName = "init.mp4";
        const staleTimeout = config.getConfig().timeouts.staleStream;

        while (!this._aborted && Date.now() - lastDownload < staleTimeout) {
            // Heartbeat
            if (Date.now() - lastHeartbeat > HEARTBEAT_INTERVAL) {
                const staleSec = ((Date.now() - lastDownload) / 1000).toFixed(0);
                logger.info(`[StreamDownloader] HEARTBEAT ${alias} segments=${segmentCount} staleSec=${staleSec}`);
                lastHeartbeat = Date.now();
            }

            // Periodic quality check — inline, no concurrent timer.
            // The download loop owns liveUrl exclusively.
            if (Date.now() - lastQualityCheck > QUALITY_CHECK_INTERVAL) {
                lastQualityCheck = Date.now();
                const betterUrl = await this.checkForQualityUpgrade(alias, liveUrl);
                if (betterUrl) {
                    logger.info(`[StreamDownloader] Quality upgrade for ${alias}: ${betterUrl.split("?")[0]}`);
                    liveUrl = betterUrl;
                    this.handle.update({ liveUrl });
                    // Don't reset any counters or timestamps — only real segments count.
                    // The new liveUrl will produce a different EXT-X-MAP if the resolution
                    // changed, which the init segment tracking below handles naturally.
                }
            }

            // Fetch playlist. Null means stop — reason was logged by the session.
            const content = await session.fetchPlaylist(liveUrl);
            if (!content) {
                logger.info(`[StreamDownloader] ${alias} playlist fetch failed — stopping (segments=${segmentCount} url=${liveUrl})`);
                break;
            }

            // Track init segment changes via EXT-X-MAP in the variant playlist.
            // Handles both first-time init and mid-stream resolution changes.
            const mapMatch = content.match(/#EXT-X-MAP:URI="([^"]+)"/);
            if (mapMatch) {
                const mapUri = mapMatch[1];
                if (mapUri !== currentMapUri) {
                    const initUrl = this.provider.getSegmentUrl(liveUrl, mapUri);
                    const initBuffer = await session.fetchSegment(initUrl);
                    if (!initBuffer) {
                        logger.warn(`[StreamDownloader] ${alias} init segment download failed url=${initUrl}`);
                        await timersPromises.setTimeout(1000);
                        continue;
                    }

                    if (currentMapUri !== null) {
                        // Not the first init — stream re-initialized mid-recording
                        initName = `init_${segmentCount}.mp4`;
                        await playlistManager.insertQualityChange(initName);
                    }

                    const initWriteOk = await FileSystemManager.writeFile(
                        path.join(segmentsDirPath, initName),
                        initBuffer as unknown as Uint8Array,
                    );
                    if (!initWriteOk) {
                        logger.warn(`[StreamDownloader] ${alias} init segment write failed for ${initName} — retrying`);
                        await timersPromises.setTimeout(1000);
                        continue;
                    }
                    logger.info(`[StreamDownloader] Downloaded init segment for ${alias} (${initName})`);
                    currentMapUri = mapUri;
                }
            }

            // Download new segments
            const segments = await playlistManager.identifyNewSegments(
                content,
                (line) => this.provider.getSegmentUrl(liveUrl, line),
            );

            let downloadedThisIteration = false;

            for (const segment of segments) {
                const tsBuffer = await session.fetchSegment(segment.remoteUrl);

                const baseName = segment.localName.replace(/\.\w+$/, "");
                if (!/^\d+$/.test(baseName)) {
                    segment.localName = `${playlistManager.startSequence + segmentCount}.ts`;
                }

                const segmentPath = path.join(segmentsDirPath, segment.localName);

                if (!tsBuffer) {
                    // Segment non-200 → stop download (same as StreaMonitor: `if m_resp.status_code != 200: return`)
                    logger.warn(`[StreamDownloader] ${alias} segment download failed segment=${segment.localName} url=${segment.remoteUrl} — stopping`);
                    segmentFailed = true;
                    break;
                }

                const writeSuccess = await FileSystemManager.writeFile(segmentPath, tsBuffer as unknown as Uint8Array);
                if (!writeSuccess) {
                    logger.error(`[StreamDownloader] ${alias} disk write failed segment=${segmentPath} — stopping`);
                    segmentFailed = true;
                    break;
                }

                const result = await this.provider.validateSegment(segmentPath);
                if (!result.valid) {
                    await fs.unlink(segmentPath).catch(() => {});
                    playlistManager.addIgnoredSegment(segment.localName);
                    logger.warn(`[StreamDownloader] ${alias} rejected invalid segment=${segment.localName}`);
                } else {
                    if (result.duration !== undefined) {
                        segment.accurateDuration = result.duration;
                    }
                    await playlistManager.appendSegmentToPlaylist(segment);
                    lastDownload = Date.now();
                    segmentCount++;
                    downloadedThisIteration = true;
                }
            }

            if (segmentFailed) break;

            // Only sleep when no new segments — the playlist fetch itself
            // is the natural throttle (HLS playlists update every 2-4s).
            // Same as StreaMonitor: `if not did_download: sleep(10)`
            if (!downloadedThisIteration) {
                await timersPromises.setTimeout(1000);
            }
        }

        const staleSec = ((Date.now() - lastDownload) / 1000).toFixed(0);
        const staleTimedOut = Date.now() - lastDownload >= staleTimeout;
        let exitReason: string;
        if (this._aborted) {
            exitReason = "aborted";
        } else if (segmentFailed) {
            exitReason = "segment-failed";
        } else if (staleTimedOut) {
            exitReason = "stale-timeout";
        } else {
            exitReason = "fetch-failed";
        }
        logger.info(`[StreamDownloader] LOOP-EXIT ${alias} reason=${exitReason} staleSec=${staleSec} segments=${segmentCount} dir=${path.basename(segmentsDirPath)}`);

        return { segmentCount, aborted: this._aborted };
    }
}
