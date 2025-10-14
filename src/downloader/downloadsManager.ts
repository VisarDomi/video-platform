// src/downloader/downloadsManager.ts

import * as path from "path";

import logger from "../common/logger.js";
import * as config from "../common/config.js";
import { FileSystemManager } from "./fileSystemManager.js";

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
    private statusFilePath: string;
    private _updateFileDebounceTimer: NodeJS.Timeout | null = null;

    /**
     * The constructor is now private. Use the async `create` method instead.
     */
    private constructor() {
        const cfg = config.getConfig();
        // Use the sharedStatePath from config for the status file
        this.statusFilePath = path.join(cfg.sharedStatePath, "live-status.json");
        logger.info(`DownloadsManager initialized. Status file: ${this.statusFilePath}`);
    }

    /**
     * Asynchronously creates and initializes an DownloadsManager.
     * This method ensures the live status file is cleared on application startup.
     */
    public static async create(): Promise<DownloadsManager> {
        const instance = new DownloadsManager();
        await instance._clearStatusFile(); // Clear the file on startup
        return instance;
    }

    public add(masterPlaylistUrl: string, initialData: Omit<Download, "liveUrl" | "segmentsDirPath">): DownloadHandle | null {
        if (this.downloads.has(masterPlaylistUrl)) {
            logger.warn(`Attempted to add an already existing download: ${masterPlaylistUrl}`);
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
            logger.error(`Attempted to update non-existent download: ${masterPlaylistUrl}`);
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

    public get size(): number {
        return this.downloads.size;
    }

    /**
     * Schedules a debounced update to the status file.
     */
    private _requestStatusFileUpdate(): void {
        if (this._updateFileDebounceTimer) {
            clearTimeout(this._updateFileDebounceTimer);
        }
        this._updateFileDebounceTimer = setTimeout(() => {
            this._updateStatusFile();
        }, 200); // Wait 200ms before writing
    }

    /**
     * Writes the current state of active downloads to the status file.
     */
    private async _updateStatusFile(): Promise<void> {
        const downloads = Array.from(this.downloads.entries()).map(([masterPlaylistUrl, downloadInfo]) => ({
            masterPlaylistUrl,
            ...downloadInfo,
        }));
        const status = { downloads, lastUpdated: new Date().toISOString() };
        await FileSystemManager.writeJsonFile(this.statusFilePath, status);
    }

    /**
     * Clears the status file by writing an empty state. This is called once on startup.
     */
    private async _clearStatusFile(): Promise<void> {
        logger.info("Clearing live-status.json for a fresh start...");
        if (this._updateFileDebounceTimer) {
            // Clear any pending writes
            clearTimeout(this._updateFileDebounceTimer);
            this._updateFileDebounceTimer = null;
        }
        this.downloads.clear();
        await this._updateStatusFile(); // Write immediately
    }
}
