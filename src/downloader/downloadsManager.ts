// src/downloader/downloadsManager.ts

import * as fsPromises from "fs/promises";
import * as path from "path";
import * as url from "url";

import logger from "../common/logger.js";
import * as config from "../common/config.js";
import * as utils from "../common/utils.js";

export interface Download {
    streamerId: string;
    alias: string;
    liveUrl: string | null;
    tsFilePath: string | null;
}

export class DownloadHandle {
    public readonly masterPlaylistUrl: string;
    private manager: DownloadsManager;

    constructor(masterPlaylistUrl: string, manager: DownloadsManager) {
        this.masterPlaylistUrl = masterPlaylistUrl;
        this.manager = manager;
    }

    public update(updates: Partial<Omit<Download, 'streamerId'>>): Download | undefined {
        return this.manager.update(this.masterPlaylistUrl, updates);
    }

    public remove(): void {
        this.manager.remove(this.masterPlaylistUrl);
    }

    public get state(): Download | undefined {
        return this.manager.get(this.masterPlaylistUrl);
    }
}

export class DownloadsManager {
    private downloads: Map<string, Download> = new Map();
    private statusFilePath: string;

    /**
     * The constructor is now private. Use the async `create` method instead.
     */
    private constructor() {
        const cfg = config.getConfig();
        const __filename = url.fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const projectRoot = utils.findProjectRoot(__dirname)
        this.statusFilePath = path.join(projectRoot, cfg.fileNames.liveStatus);
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

    public add(masterPlaylistUrl: string, initialData: Omit<Download, 'liveUrl' | 'tsFilePath'>): DownloadHandle | null {
        if (this.downloads.has(masterPlaylistUrl)) {
            logger.warn(`Attempted to add an already existing download: ${masterPlaylistUrl}`);
            return null;
        }
        
        const newDownload: Download = {
            ...initialData,
            liveUrl: null,
            tsFilePath: null,
        };

        this.downloads.set(masterPlaylistUrl, newDownload);
        this._updateStatusFile();
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
        this._updateStatusFile();
        return updated;
    }

    public remove(masterPlaylistUrl: string): void {
        if (this.downloads.delete(masterPlaylistUrl)) {
            this._updateStatusFile();
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
     * Writes the current state of active downloads to the status file.
     */
    private async _updateStatusFile(): Promise<void> {
        try {
            const downloads = Array.from(this.downloads.entries()).map(([masterPlaylistUrl, downloadInfo]) => ({
                masterPlaylistUrl,
                ...downloadInfo,
            }));
            const status = { downloads, lastUpdated: new Date().toISOString() };
            await fsPromises.writeFile(this.statusFilePath, JSON.stringify(status, null, 2));
        } catch (error) {
            logger.error("Failed to write download status to live-status.json", { error });
        }
    }

    /**
     * Clears the status file by writing an empty state. This is called once on startup.
     */
    private async _clearStatusFile(): Promise<void> {
        logger.info("Clearing live-status.json for a fresh start...");
        this.downloads.clear(); // Ensure in-memory state is also clear
        await this._updateStatusFile(); // This will write an empty `downloads` array
    }
}