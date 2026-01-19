import * as path from "path";
import * as fs from "fs/promises";
import * as config from "../../../common/config.js";
import { FileSystemManager } from "../../../common/fileSystemManager.js";
import logger from "../../../common/logger.js";
import { IStreamProvider } from "../../core/interfaces.js";
import { MediaValidator } from "../../../common/mediaValidator.js";
import { ScBrowserService, ScSniffResult } from "./scBrowserService.js";

export class ScClient implements IStreamProvider {
    private browserService: ScBrowserService;
    // Store headers per channel to use for segments
    private sessionHeaders: Map<string, Record<string, string>> = new Map();

    private readonly DEFAULT_HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://stripchat.com/",
        "Origin": "https://stripchat.com",
    };

    constructor() {
        this.browserService = ScBrowserService.getInstance();
        logger.info("[SC] Client initialized.");
    }

    public async isOnline(channelId: string): Promise<boolean> {
        // Quick API check first to avoid heavy browser launch if offline
        try {
            const url = `https://stripchat.com/api/front/v2/models/username/${channelId}/cam`;
            const response = await fetch(url, { headers: this.DEFAULT_HEADERS });
            if (!response.ok) return false;

            const data = await response.json();
            const modelStatus = data.user?.user?.status;
            const cam = data.cam;

            if (modelStatus === "public" && cam?.isCamAvailable && cam?.isCamActive) {
                return true;
            }
            return false;
        } catch (error: any) {
            logger.error(`[SC] Error checking online status for ${channelId}`, { error: error.message });
            return false;
        }
    }

    public async getHlsUrl(channelId: string): Promise<string | null> {
        // Use Playwright to get the exact URL the player uses (with pkey, etc.)
        const result = await this.browserService.sniffPlaylist(channelId);

        if (result) {
            this.sessionHeaders.set(channelId, result.headers);
            return result.url;
        }
        return null;
    }

    // Helper to get headers for a request, falling back to default
    private getHeaders(url: string): Record<string, string> {
        // Attempt to match URL to a known session (this is imperfect if URLs change significantly)
        // Ideally we pass context, but IStreamProvider interface doesn't support state well yet.
        // We will return the most recently sniffed headers + defaults
        // For now, let's mix in the defaults
        return this.DEFAULT_HEADERS;
    }

    public async parseMasterPlaylist(masterUrl: string): Promise<string | null> {
        // Since we sniffed the live URL directly (likely), just return it.
        // The sniffer regex looks for .m3u8.
        // If it's a master playlist, we might parse it.

        // If the URL contains "master", it's a master playlist
        if (masterUrl.includes("/master/")) {
            const content = await this.getMasterList(masterUrl);
            if (!content) return null;

            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
                    if (i + 1 < lines.length) {
                        return this.getSegmentUrl(masterUrl, lines[i+1].trim());
                    }
                }
            }
        }

        // It might already be a variant playlist
        return masterUrl;
    }

    public async pollCurrentVariant(masterUrl: string, currentLiveUrl: string): Promise<string | null> {
        // No polling implemented for SC yet
        return null;
    }

    public async getMasterList(url: string): Promise<string | null> {
        try {
            const res = await fetch(url, { headers: this.DEFAULT_HEADERS });
            return res.ok ? await res.text() : null;
        } catch { return null; }
    }

    public async getLiveList(liveUrl: string): Promise<{ success: boolean; data: string | null }> {
        try {
            const response = await fetch(liveUrl, { headers: this.DEFAULT_HEADERS });
            if (!response.ok) {
                return { success: false, data: null };
            }
            const data = await response.text();
            return { success: true, data };
        } catch (error: any) {
            logger.error(`[SC] getLiveList error`, { error: error.message });
            return { success: false, data: null };
        }
    }

    public async getTsSegment(url: string): Promise<Buffer | null> {
        try {
            const response = await fetch(url, { headers: this.DEFAULT_HEADERS });
            if (response.ok) {
                const arr = await response.arrayBuffer();
                return Buffer.from(arr);
            }
            logger.warn(`[SC] Segment fetch failed: ${response.status} ${url}`);
            return null;
        } catch (error) { return null; }
    }

    public getSegmentUrl(baseUrl: string, segmentLine: string): string {
        try {
            return new URL(segmentLine, baseUrl).href;
        } catch {
            return segmentLine;
        }
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

        const storageLocationExists = await FileSystemManager.ensureDirExists(storageLocation);
        if (!storageLocationExists) return null;

        const segmentsDirPath = path.resolve(storageLocation, baseFilename);
        const segmentsDirExists = await FileSystemManager.ensureDirExists(segmentsDirPath);
        return segmentsDirExists ? segmentsDirPath : null;
    }

    public async validateSegment(filePath: string): Promise<boolean> {
        const info = await MediaValidator.getMediaInfo(filePath);
        if (!info) return false;

        // Relaxed validation: SC often has very short segments or weird headers
        if (isNaN(info.bitRate) && info.duration > 0) return true;
        if (info.bitRate > 0) return true;

        return false;
    }
}