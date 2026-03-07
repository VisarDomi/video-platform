import * as path from "path";
import * as fs from "fs/promises";
import * as config from "../../../common/config.js";
import { FileSystemManager } from "../../../common/fileSystemManager.js";
import logger from "../../../common/logger.js";
import { IStreamProvider } from "../../core/interfaces.js";
import { MediaValidator } from "../../../common/mediaValidator.js";
import { ScPageController } from "./scPageController.js";

interface ScSession {
    controller: ScPageController;
    lastAccess: number;
}

export class ScClient implements IStreamProvider {
    private sessions: Map<string, ScSession> = new Map();
    private cleanupInterval: NodeJS.Timeout;
    private _lastLogTime: Map<string, number> = new Map();

    constructor() {
        logger.debug("[SC] Client initialized.");
        this.cleanupInterval = setInterval(() => this._cleanupStaleSessions(), 30000);
    }

    private _cleanupStaleSessions() {
        const now = Date.now();
        // If a session hasn't been touched (polled) in 60s, kill it.
        const TIMEOUT_MS = 60000;

        for (const [channelId, session] of this.sessions.entries()) {
            if (now - session.lastAccess > TIMEOUT_MS) {
                logger.info(`[SC] Session for ${channelId} timed out. Stopping controller.`);
                this._closeSession(channelId);
            }
        }
    }

    private async _closeSession(channelId: string) {
        const session = this.sessions.get(channelId);
        if (session) {
            await session.controller.stop();
            this.sessions.delete(channelId);
        }
    }

    // Force close specific session (useful if downloader detects stall)
    public async forceCloseSession(channelId: string) {
        logger.info(`[SC] Forcing close of session: ${channelId}`);
        await this._closeSession(channelId);
    }

    public async isOnline(channelId: string): Promise<boolean> {
        try {
            const url = `https://stripchat.com/api/front/v2/models/username/${channelId}/cam`;
            const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
            if (!response.ok) return false;
            const data = await response.json();
            return (data.user?.user?.status === "public" && data.cam?.isCamAvailable && data.cam?.isCamActive);
        } catch { return false; }
    }

    public async getHlsUrl(channelId: string): Promise<string | null> {
        // We use a fake URL scheme to pass the channelId around
        return `http://synthetic-sc/${channelId}/playlist.m3u8`;
    }

    private _touchSession(channelId: string) {
        const session = this.sessions.get(channelId);
        if (session) {
            session.lastAccess = Date.now();
        }
    }

    public async parseMasterPlaylist(masterUrl: string): Promise<string | null> {
        const match = masterUrl.match(/synthetic-sc\/([^\/]+)\//);
        const channelId = match ? match[1] : masterUrl;

        let session = this.sessions.get(channelId);

        if (!session || !session.controller.isActive()) {
            logger.info(`[SC-DEBUG] parseMasterPlaylist ${channelId} session=${!!session} active=${session?.controller.isActive()} → creating new session`);
            await this._closeSession(channelId);

            const controller = new ScPageController(channelId);
            session = {
                controller,
                lastAccess: Date.now()
            };
            this.sessions.set(channelId, session);
            await controller.start();
        } else {
            logger.info(`[SC-DEBUG] parseMasterPlaylist ${channelId} reusing existing session`);
        }

        const playlistPath = path.join(session.controller.tempDir, "playlist.m3u8");

        // Wait for FFmpeg to produce the playlist
        for (let i = 0; i < 60; i++) {
            try {
                this._touchSession(channelId);
                const stat = await fs.stat(playlistPath);
                if (stat.size > 0) {
                    logger.info(`[SC] [${channelId}] HLS Playlist ready.`);
                    return masterUrl;
                }
            } catch {}
            await new Promise(r => setTimeout(r, 1000));
        }

        logger.warn(`[SC] [${channelId}] Timed out waiting for playlist.`);
        await this._closeSession(channelId);
        return null;
    }

    public async pollCurrentVariant(masterUrl: string, currentLiveUrl: string): Promise<string | null> {
        return null;
    }

    public async getMasterList(url: string): Promise<string | null> {
        return null;
    }

    public async getLiveList(liveUrl: string): Promise<{ success: boolean; data: string | null }> {
        const match = liveUrl.match(/synthetic-sc\/([^\/]+)\//);
        const channelId = match ? match[1] : "";

        const session = this.sessions.get(channelId);
        if (!session || !session.controller.isActive()) {
            // Debounce: only log once per 30s per channel
            const now = Date.now();
            const key = `getLiveList_fail_${channelId}`;
            if (!this._lastLogTime.has(key) || now - this._lastLogTime.get(key)! > 30000) {
                logger.info(`[SC-DEBUG] getLiveList FAIL ${channelId} session=${!!session} active=${session?.controller.isActive()}`);
                this._lastLogTime.set(key, now);
            }
            return { success: false, data: null };
        }

        this._touchSession(channelId);

        try {
            const playlistPath = path.join(session.controller.tempDir, "playlist.m3u8");
            const data = await fs.readFile(playlistPath, "utf-8");

            const rewritten = data.split('\n').map(line => {
                if (line.endsWith('.ts') && !line.startsWith('http')) {
                    return `sc_local_STREAMER_${channelId}_FILE_${line}`;
                }
                return line;
            }).join('\n');

            return { success: true, data: rewritten };
        } catch (e) {
            return { success: false, data: null };
        }
    }

    public async getTsSegment(url: string): Promise<Buffer | null> {
        const parts = url.split('_FILE_');

        if (parts.length === 2) {
            const prefixPart = parts[0];
            const filename = parts[1];
            const channelId = prefixPart.replace('sc_local_STREAMER_', '');

            const session = this.sessions.get(channelId);
            if (session) {
                this._touchSession(channelId);
                const filePath = path.join(session.controller.tempDir, filename);
                try {
                    const data = await fs.readFile(filePath);
                    return data;
                } catch (e: any) {
                    return null;
                }
            }
        }
        return null;
    }

    public getSegmentUrl(baseUrl: string, segmentLine: string): string {
        return segmentLine;
    }

    public async setupDownloadDir(alias: string, date: Date): Promise<string | null> {
        const generateDownloadBaseName = (alias: string, date: Date): string => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, "0");
            const day = String(date.getDate()).padStart(2, "0");
            const hours = String(date.getHours()).padStart(2, "0");
            const minutes = String(date.getMinutes()).padStart(2, "0");
            const seconds = String(date.getSeconds()).padStart(2, "0");
            return `${year}-${month}-${day} ${hours}${minutes}${seconds} ${alias}`;
        };

        const baseFilename = generateDownloadBaseName(alias, date);
        const storageLocation = path.join(config.getConfig().storagePath, "sc", "downloader");

        await FileSystemManager.ensureDirExists(storageLocation);
        const segmentsDirPath = path.resolve(storageLocation, baseFilename);
        const segmentsDirExists = await FileSystemManager.ensureDirExists(segmentsDirPath);
        return segmentsDirExists ? segmentsDirPath : null;
    }

    public async validateSegment(filePath: string): Promise<{ valid: boolean }> {
        try {
            const stat = await fs.stat(filePath);
            return { valid: stat.size > 0 };
        } catch {
            return { valid: false };
        }
    }
}