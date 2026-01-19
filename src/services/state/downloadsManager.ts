import * as path from "path";

import logger from "../../common/logger.js";
import * as config from "../../common/config.js";
import { FileSystemManager } from "../../common/fileSystemManager.js";

interface Download {
    streamerId: string;
    alias: string;
    liveUrl: string | null;
    segmentsDirPath: string | null;
}

export class DownloadHandle {
    public readonly masterPlaylistUrl: string;
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
    private readonly statusFilePath: string;
    private _updateFileDebounceTimer: NodeJS.Timeout | null = null;

    private constructor() {
        const cfg = config.getConfig();
        this.statusFilePath = path.join(cfg.sharedStatePath, "live-status.json");
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

    public remove(masterPlaylistUrl: string): void {
        if (this.downloads.delete(masterPlaylistUrl)) {
            this._requestStatusFileUpdate();
        }
    }

    public get(masterPlaylistUrl: string): Download | undefined {
        return this.downloads.get(masterPlaylistUrl);
    }

    public has(masterPlaylistUrl: string): boolean {
        return this.downloads.has(masterPlaylistUrl);
    }

    /**
     * Checks if a specific streamer ID is currently being downloaded.
     * Useful when URLs change dynamically (e.g. FC2).
     */
    public hasStreamer(streamerId: string): boolean {
        for (const download of this.downloads.values()) {
            if (download.streamerId === streamerId) {
                return true;
            }
        }
        return false;
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
        }, 200);
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
        await this._updateStatusFile(); // Write immediately
    }
}