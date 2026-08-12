import * as path from "path";

import logger from "../../common/logger.js";
import { config } from "../../common/config.js";
import { FileSystemManager } from "../../common/fileSystemManager.js";
import { STATUS_FILE_DEBOUNCE_MS } from "../../common/timing.js";

interface Download {
    streamerId: string;
    recordingId: string;
    alias: string;
    liveUrl: string | null;
    segmentsDirPath: string | null;
}

interface ActiveDownloader {
    streamerId: string;
    abort: () => void;
    finalize: () => void;
    completion: Promise<void>;
}

export class DownloadHandle {
    public masterPlaylistUrl: string;
    private downloadsManager: DownloadsManager;

    constructor(masterPlaylistUrl: string, downloadsManager: DownloadsManager) {
        this.masterPlaylistUrl = masterPlaylistUrl;
        this.downloadsManager = downloadsManager;
    }

    public update(updates: Partial<Omit<Download, "streamerId">>): Download | undefined {
        return this.downloadsManager.update(this.masterPlaylistUrl, updates);
    }

    public remove(): void {
        this.downloadsManager.remove(this.masterPlaylistUrl);
    }

    public get state(): Download | undefined {
        return this.downloadsManager.get(this.masterPlaylistUrl);
    }
}

export class DownloadsManager {
    private downloads: Map<string, Download> = new Map();
    private activeDownloaders: Map<string, ActiveDownloader> = new Map();
    private readonly statusFilePath: string;
    private _updateFileDebounceTimer: NodeJS.Timeout | null = null;

    private constructor() {
        this.statusFilePath = path.join(config.sharedStatePath, "live-status.json");
        logger.info(`[General] DownloadsManager initialized. Status file: ${this.statusFilePath}`);
    }

    public static async create(): Promise<DownloadsManager> {
        const instance = new DownloadsManager();
        await instance._clearStatusFile();
        return instance;
    }

    public add(masterPlaylistUrl: string, initialData: Omit<Download, "liveUrl" | "segmentsDirPath">): DownloadHandle | null {
        if (this.downloads.has(masterPlaylistUrl)) {
            logger.warn(`[General] Attempted to add an already existing download: ${masterPlaylistUrl}`);
            return null;
        }

        const newDownload: Download = {
            ...initialData,
            liveUrl: null,
            segmentsDirPath: null,
        };

        this.downloads.set(masterPlaylistUrl, newDownload);
        this._requestStatusFileUpdate();
        return new DownloadHandle(masterPlaylistUrl, this);
    }

    public update(masterPlaylistUrl: string, updates: Partial<Download>): Download | undefined {
        const existing = this.downloads.get(masterPlaylistUrl);
        if (!existing) {
            logger.error(`[General] Attempted to update non-existent download: ${masterPlaylistUrl}`);
            return undefined;
        }

        const updated = { ...existing, ...updates };
        this.downloads.set(masterPlaylistUrl, updated);
        this._requestStatusFileUpdate();
        return updated;
    }

    public registerDownloader(
        masterPlaylistUrl: string,
        streamerId: string,
        abort: () => void,
        finalize: () => void,
        completion: Promise<void>,
    ): void {
        this.activeDownloaders.set(masterPlaylistUrl, { streamerId, abort, finalize, completion });
        completion.finally(() => {
            this.activeDownloaders.delete(masterPlaylistUrl);
        });
    }

    public async finalizeStreamer(streamerId: string): Promise<boolean> {
        const active = [...this.activeDownloaders.values()].find((download) => download.streamerId === streamerId);
        if (!active) return false;
        active.finalize();
        await active.completion;
        return true;
    }

    public remove(masterPlaylistUrl: string): void {
        const existing = this.downloads.get(masterPlaylistUrl);
        if (existing) {
            logger.info(`[StreamDownloader] DM-REMOVE streamer=${existing.streamerId} dir=${existing.segmentsDirPath ? existing.segmentsDirPath.split("/").pop() : "none"}`);
        }
        if (this.downloads.delete(masterPlaylistUrl)) {
            this._requestStatusFileUpdate();
        }
    }

    public async shutdownAll(): Promise<void> {
        const count = this.activeDownloaders.size;
        if (count === 0) return;

        logger.info(`[General] Shutting down ${count} active download(s)...`);

        for (const downloader of this.activeDownloaders.values()) {
            downloader.abort();
        }

        await Promise.allSettled(
            Array.from(this.activeDownloaders.values()).map(d => d.completion)
        );

        logger.info(`[General] All active downloads stopped and left resumable.`);
    }

    public get(masterPlaylistUrl: string): Download | undefined {
        return this.downloads.get(masterPlaylistUrl);
    }

    public has(masterPlaylistUrl: string): boolean {
        return this.downloads.has(masterPlaylistUrl);
    }
    public hasStreamer(streamerId: string): boolean {
        for (const download of this.downloads.values()) {
            if (download.streamerId === streamerId) {
                return true;
            }
        }
        return false;
    }

    public getRecordingId(streamerId: string): string | null {
        for (const download of this.downloads.values()) {
            if (download.streamerId === streamerId) return download.recordingId;
        }
        return null;
    }

    public get size(): number {
        return this.downloads.size;
    }

    public getActiveSegmentPaths(): Set<string> {
        const paths = new Set<string>();
        for (const download of this.downloads.values()) {
            if (download.segmentsDirPath) {
                paths.add(download.segmentsDirPath);
            }
        }
        return paths;
    }

    private _requestStatusFileUpdate(): void {
        if (this._updateFileDebounceTimer) {
            clearTimeout(this._updateFileDebounceTimer);
        }
        this._updateFileDebounceTimer = setTimeout(() => {
            void this._updateStatusFile();
        }, STATUS_FILE_DEBOUNCE_MS);
    }

    private async _updateStatusFile(): Promise<void> {
        const downloads = Array.from(this.downloads.entries()).map(([masterPlaylistUrl, downloadInfo]) => ({
            masterPlaylistUrl,
            ...downloadInfo,
        }));
        const status = { downloads, lastUpdated: new Date().toISOString() };
        await FileSystemManager.writeJsonFile(this.statusFilePath, status);
    }

    private async _clearStatusFile(): Promise<void> {
        logger.info("[General] Clearing live-status.json for a fresh start...");
        if (this._updateFileDebounceTimer) {
            clearTimeout(this._updateFileDebounceTimer);
            this._updateFileDebounceTimer = null;
        }
        this.downloads.clear();
        await this._updateStatusFile();
    }
}
