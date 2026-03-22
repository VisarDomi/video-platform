import * as path from "path";
import * as timersPromises from "timers/promises";

import logger from "../../common/logger.js";
import { DownloadHandle } from "../state/downloadsManager.js";
import { IStreamProvider, DownloadExitContext } from "../core/interfaces.js";
import { StreamDownloader, DownloadResult } from "./streamDownloader.js";
import { PlaylistManager } from "./playlistManager.js";
import { InitTracker } from "./initTracker.js";
import { DiskSession } from "./diskSession.js";

export interface SessionResult {
    totalSegments: number;
    aborted: boolean;
}

/**
 * Owns the lifecycle of a single stream recording session.
 *
 * One session = one folder on disk. The session retries the download
 * when it fails, asking the provider "should I retry?" between attempts.
 * The provider owns the liveness decision (different per platform).
 *
 * Owns: DiskSession, PlaylistManager, InitTracker, DownloadHandle.
 * StreamDownloader is created per-attempt and receives these as inputs.
 */
export class StreamSession {
    private readonly streamerId: string;
    private readonly alias: string;
    private readonly handle: DownloadHandle;
    private readonly provider: IStreamProvider;
    private _aborted = false;
    private activeDownloader: StreamDownloader | null = null;

    constructor(
        streamerId: string,
        alias: string,
        handle: DownloadHandle,
        provider: IStreamProvider,
    ) {
        this.streamerId = streamerId;
        this.alias = alias;
        this.handle = handle;
        this.provider = provider;
    }

    public abort(): void {
        this._aborted = true;
        this.activeDownloader?.abort();
    }

    public async run(initialMasterUrl: string): Promise<SessionResult> {
        const disk = new DiskSession(
            this.alias,
            this.handle,
            () => this.provider.setupDownloadDir(this.alias, new Date()),
        );
        const playlistManager = new PlaylistManager(disk);
        const initTracker = new InitTracker(disk);

        let masterUrl = initialMasterUrl;
        let totalSegments = 0;

        while (!this._aborted) {
            const downloader = new StreamDownloader(this.handle, this.provider);
            this.activeDownloader = downloader;
            const result = await downloader.run(masterUrl, playlistManager, initTracker, disk);
            this.activeDownloader = null;
            totalSegments += result.segmentCount;

            if (result.aborted) break;

            const context: DownloadExitContext = {
                streamerId: this.streamerId,
                exitReason: result.exitReason,
                lastMasterUrl: masterUrl,
                lastLiveUrl: result.lastLiveUrl,
            };

            const retryUrl = await this.provider.shouldRetry(context);
            if (!retryUrl) {
                logger.info(`[StreamSession] ${this.alias}: stream ended (reason=${result.exitReason}, segments=${totalSegments})`);
                break;
            }

            masterUrl = retryUrl;
            logger.info(`[StreamSession] ${this.alias}: retrying (reason=${result.exitReason}, newMaster=${masterUrl !== context.lastMasterUrl})`);
            await timersPromises.setTimeout(5000);
        }

        if (disk.materialized) {
            await playlistManager.finalizePlaylist();
            logger.info(`[StreamSession] ${this.alias}: finalized dir=${path.basename(disk.dirPath)} totalSegments=${totalSegments}`);
        }

        this.handle.remove();
        return { totalSegments, aborted: this._aborted };
    }
}
