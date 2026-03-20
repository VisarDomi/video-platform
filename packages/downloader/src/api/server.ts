import express from "express";
import * as fs from "fs/promises";
import * as path from "path";

import logger from "../common/logger.js";
import { FileSystemManager } from "../common/fileSystemManager.js";
import { StreamDownloader } from "../services/download/streamDownloader.js";
import { IStreamProvider } from "../services/core/interfaces.js";
import { DownloadHandle } from "../services/state/downloadsManager.js";

const TL_BASE_PATH = "/tmp/Videos/downloads/tl";

interface EphemeralDownload {
    alias: string;
    streamerId: string;
    downloader: StreamDownloader;
    startedAt: string;
}
class EphemeralDownloadHandle {
    public readonly masterPlaylistUrl: string;
    private _state: { streamerId: string; alias: string; liveUrl: string | null; segmentsDirPath: string | null };

    constructor(masterPlaylistUrl: string, streamerId: string, alias: string) {
        this.masterPlaylistUrl = masterPlaylistUrl;
        this._state = { streamerId, alias, liveUrl: null, segmentsDirPath: null };
    }

    public update(updates: Record<string, any>) {
        Object.assign(this._state, updates);
        return this._state;
    }

    public remove(): void {
    }

    public get state() {
        return this._state;
    }
}
class EphemeralStreamProvider implements IStreamProvider {
    private inner: IStreamProvider;
    private dirPath: string;

    constructor(inner: IStreamProvider, dirPath: string) {
        this.inner = inner;
        this.dirPath = dirPath;
    }

    async parseMasterPlaylist(masterUrl: string) {
        return this.inner.parseMasterPlaylist(masterUrl);
    }
    async pollCurrentVariant(masterUrl: string, currentLiveUrl: string) {
        return this.inner.pollCurrentVariant(masterUrl, currentLiveUrl);
    }
    async getMasterList(url: string) {
        return this.inner.getMasterList(url);
    }
    async getLiveList(url: string) {
        return this.inner.getLiveList(url);
    }
    async getTsSegment(url: string) {
        return this.inner.getTsSegment(url);
    }
    getSegmentUrl(baseUrl: string, segmentLine: string) {
        return this.inner.getSegmentUrl(baseUrl, segmentLine);
    }
    async validateSegment(filePath: string) {
        return this.inner.validateSegment(filePath);
    }
    async setupDownloadDir(_alias: string, _date: Date): Promise<string | null> {
        const ok = await FileSystemManager.ensureDirExists(this.dirPath);
        return ok ? this.dirPath : null;
    }
}

export function createApiServer(tangoApiClient: IStreamProvider, port = 7974) {
    const app = express();
    app.use(express.json());

    const activeDownloads = new Map<string, EphemeralDownload>();

    let wantedAliases = new Set<string>();
    let lastActiveTimestamp = 0;
    const CLEANUP_INTERVAL = 10_000;
    const STALE_TIMEOUT = 60_000;

    async function cleanupDir(alias: string) {
        const dirPath = path.join(TL_BASE_PATH, alias);
        try {
            await fs.rm(dirPath, { recursive: true, force: true });
        } catch {
        }
    }

    setInterval(() => {
        if (activeDownloads.size === 0) return;
        const now = Date.now();
        const isStale = lastActiveTimestamp > 0 && (now - lastActiveTimestamp > STALE_TIMEOUT);

        for (const [alias, entry] of activeDownloads) {
            if (isStale || !wantedAliases.has(alias)) {
                logger.info(`[API] Cleanup: stopping ${alias} (${isStale ? "stale heartbeat" : "not in active set"})`);
                entry.downloader.abort();
                activeDownloads.delete(alias);
                void cleanupDir(alias);
            }
        }

        if (isStale && activeDownloads.size === 0) {
            wantedAliases = new Set();
            lastActiveTimestamp = 0;
        }
    }, CLEANUP_INTERVAL);

    app.post("/api/download/start", async (req, res) => {
        const { masterPlaylistUrl, alias, streamerId } = req.body;
        if (!masterPlaylistUrl || !alias || !streamerId) {
            res.status(400).json({ success: false, error: "Missing required fields: masterPlaylistUrl, alias, streamerId" });
            return;
        }

        if (activeDownloads.has(alias)) {
            res.json({ success: true, filename: alias, message: "Already downloading" });
            return;
        }

        const dirPath = path.join(TL_BASE_PATH, alias);
        const ephemeralProvider = new EphemeralStreamProvider(tangoApiClient, dirPath);
        const handle = new EphemeralDownloadHandle(masterPlaylistUrl, streamerId, alias) as unknown as DownloadHandle;
        const downloader = new StreamDownloader(handle, ephemeralProvider);

        const entry: EphemeralDownload = {
            alias,
            streamerId,
            downloader,
            startedAt: new Date().toISOString(),
        };
        activeDownloads.set(alias, entry);

        downloader.start().then(() => {
            logger.info(`[API] Ephemeral download completed for ${alias}`);
            activeDownloads.delete(alias);
        }).catch((err) => {
            logger.error(`[API] Ephemeral download failed for ${alias}`, { error: (err as Error).message });
            activeDownloads.delete(alias);
        });

        const playlistPath = path.join(dirPath, "playlist.m3u8");
        const POLL_INTERVAL = 200;
        const TIMEOUT = 15000;
        const start = Date.now();
        const poll = async (): Promise<boolean> => {
            while (Date.now() - start < TIMEOUT) {
                try {
                    const stat = await fs.stat(playlistPath);
                    if (stat.size > 0) return true;
                } catch {
                }
                await new Promise(r => setTimeout(r, POLL_INTERVAL));
            }
            return false;
        };

        const ready = await poll();
        if (ready) {
            res.json({ success: true, filename: alias });
        } else {
            res.status(504).json({ success: false, error: "Timed out waiting for playlist" });
        }
    });

    app.post("/api/download/stop", async (req, res) => {
        const { alias } = req.body;
        if (!alias) {
            res.status(400).json({ success: false, error: "Missing required field: alias" });
            return;
        }

        const entry = activeDownloads.get(alias);
        if (entry) {
            entry.downloader.abort();
            activeDownloads.delete(alias);
        }

        await cleanupDir(alias);

        res.json({ success: true });
    });

    app.post("/api/download/active", (req, res) => {
        const { aliases } = req.body;
        if (!Array.isArray(aliases)) {
            res.status(400).json({ success: false, error: "aliases must be an array" });
            return;
        }
        wantedAliases = new Set(aliases);
        lastActiveTimestamp = Date.now();
        res.json({ success: true, active: Array.from(activeDownloads.keys()), wanted: aliases });
    });

    app.get("/api/download/status", (_req, res) => {
        const downloads = Array.from(activeDownloads.values()).map(({ alias, streamerId, startedAt }) => ({
            alias,
            streamerId,
            startedAt,
        }));
        res.json(downloads);
    });

    app.listen(port, () => {
        logger.info(`[API] HTTP server listening on port ${port}`);
    });

    return app;
}
