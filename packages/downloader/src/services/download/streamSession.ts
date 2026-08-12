import * as path from "path";
import * as timersPromises from "timers/promises";

import logger from "../../common/logger.js";
import { SESSION_RETRY_SLEEP_MS } from "../../common/timing.js";
import { DownloadHandle } from "../state/downloadsManager.js";
import { IStreamProvider, DownloadExitContext } from "../core/interfaces.js";
import { setupDownloadDir } from "../core/downloadUtils.js";
import { StreamDownloader, DownloadResult } from "./streamDownloader.js";
import { PlaylistManager } from "./playlistManager.js";
import { InitTracker } from "./initTracker.js";
import { DiskSession } from "./diskSession.js";
import { promoteActiveRecording } from "./activeRecording.js";

export interface SessionResult {
    totalSegments: number;
    aborted: boolean;
}

export class StreamSession {
    private readonly streamerId: string;
    private readonly alias: string;
    private readonly handle: DownloadHandle;
    private readonly provider: IStreamProvider;
    private _aborted = false;
    private activeDownloader: StreamDownloader | null = null;
    private _finalizeRequested = false;
    private readonly recordingId: string;
    private readonly existingDirPath?: string;

    constructor(
        streamerId: string,
        alias: string,
        handle: DownloadHandle,
        provider: IStreamProvider,
        recordingId: string,
        existingDirPath?: string,
    ) {
        this.streamerId = streamerId;
        this.alias = alias;
        this.handle = handle;
        this.provider = provider;
        this.recordingId = recordingId;
        this.existingDirPath = existingDirPath;
    }

    public abort(): void {
        this._aborted = true;
        this.activeDownloader?.abort();
    }

    public finalize(): void {
        this._finalizeRequested = true;
        this._aborted = true;
        this.activeDownloader?.abort();
    }

    public async run(initialMasterUrl: string): Promise<SessionResult> {
        const disk = new DiskSession(
            this.alias,
            this.handle,
            () => setupDownloadDir(this.provider.providerName, this.alias, new Date()),
            this.existingDirPath,
        );
        const playlistManager = new PlaylistManager(disk, this.recordingId);
        const initTracker = new InitTracker(disk);
        if (this.existingDirPath) {
            await playlistManager.initializeFromExistingPlaylist();
            initTracker.markResumeBoundary(playlistManager.nextSegmentNumber);
        }

        let masterUrl = initialMasterUrl;
        let endedByUpstream = false;

        while (!this._aborted) {
            const downloader = new StreamDownloader(this.handle, this.provider);
            this.activeDownloader = downloader;
            const result = await downloader.run(masterUrl, playlistManager, initTracker, disk);
            this.activeDownloader = null;
            if (result.exitReason === "remote-endlist") {
                endedByUpstream = true;
                break;
            }

            if (result.aborted) break;

            const context: DownloadExitContext = {
                streamerId: this.streamerId,
                recordingId: this.recordingId,
                lookupAlias: this.alias,
                exitReason: result.exitReason,
                lastMasterUrl: masterUrl,
                lastLiveUrl: result.lastLiveUrl,
            };

            const retryUrl = await this.provider.shouldRetry(context);
            if (!retryUrl) {
                logger.info(`[StreamSession] ${this.alias}: provider state not resumable yet; retaining active recording (reason=${result.exitReason})`);
                masterUrl = context.lastMasterUrl;
            } else {
                masterUrl = retryUrl;
            }

            logger.info(`[StreamSession] ${this.alias}: retrying (reason=${result.exitReason}, newMaster=${masterUrl !== context.lastMasterUrl})`);
            await timersPromises.setTimeout(SESSION_RETRY_SLEEP_MS);
        }

        if (disk.materialized && (endedByUpstream || this._finalizeRequested)) {
            await playlistManager.finalizePlaylist();
            const finalizedPath = await promoteActiveRecording(disk.dirPath);
            this.handle.update({ segmentsDirPath: finalizedPath });
            logger.info(`[StreamSession] ${this.alias}: finalized dir=${path.basename(finalizedPath)} totalSegments=${initTracker.count}`);
        }

        this.handle.remove();
        return { totalSegments: initTracker.count, aborted: this._aborted && !this._finalizeRequested };
    }
}
