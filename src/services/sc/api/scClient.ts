import * as path from "path";
import * as fs from "fs/promises";
import * as config from "../../../common/config.js";
import { FileSystemManager } from "../../../common/fileSystemManager.js";
import logger from "../../../common/logger.js";
import { IStreamProvider } from "../../core/interfaces.js";
import { MediaValidator } from "../../../common/mediaValidator.js";
import { ScPageController } from "./scPageController.js";

export class ScClient implements IStreamProvider {
    private controllers: Map<string, ScPageController> = new Map();

    constructor() {
        logger.info("[SC] Client initialized (FFmpeg HLS Mode).");
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
        return `http://synthetic-sc/${channelId}/playlist.m3u8`;
    }

    public async parseMasterPlaylist(masterUrl: string): Promise<string | null> {
        const match = masterUrl.match(/synthetic-sc\/([^\/]+)\//);
        const channelId = match ? match[1] : masterUrl;

        let controller = this.controllers.get(channelId);

        if (!controller || !controller.isActive()) {
            controller = new ScPageController(channelId);
            this.controllers.set(channelId, controller);
            await controller.start();
        }

        const playlistPath = path.join(controller.tempDir, "playlist.m3u8");

        // Wait for FFmpeg to produce the playlist
        for (let i = 0; i < 30; i++) {
            try {
                const stat = await fs.stat(playlistPath);
                if (stat.size > 0) {
                    logger.info(`[SC] [${channelId}] HLS Playlist ready.`);
                    return masterUrl;
                }
            } catch {}
            await new Promise(r => setTimeout(r, 1000));
        }

        logger.warn(`[SC] [${channelId}] Timed out waiting for playlist.`);
        await controller.stop();
        this.controllers.delete(channelId);
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

        const controller = this.controllers.get(channelId);
        if (!controller || !controller.isActive()) return { success: false, data: null };

        try {
            const playlistPath = path.join(controller.tempDir, "playlist.m3u8");
            const data = await fs.readFile(playlistPath, "utf-8");

            // Rewrite the TS paths in the playlist to be resolvable by our synthetic system
            // Local file: segment_000.ts -> Synthetic URL: sc_local_{channelId}_segment_000.ts
            // We use a custom separator to strictly split channelId vs filename later
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
        // Format: sc_local_STREAMER_{channelId}_FILE_{filename}
        const parts = url.split('_FILE_');

        if (parts.length === 2) {
            const prefixPart = parts[0];
            const filename = parts[1];

            const channelId = prefixPart.replace('sc_local_STREAMER_', '');

            const controller = this.controllers.get(channelId);
            if (controller) {
                const filePath = path.join(controller.tempDir, filename);
                try {
                    const data = await fs.readFile(filePath);
                    return data;
                } catch (e: any) {
                    logger.warn(`[SC] Failed to read segment file: ${filePath}`, { error: e.message });
                    return null;
                }
            } else {
                logger.warn(`[SC] Controller not found for channel: ${channelId} (URL: ${url})`);
            }
        } else {
            logger.warn(`[SC] Malformed TS URL: ${url}`);
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

    public async validateSegment(filePath: string): Promise<boolean> {
        try {
            const stat = await fs.stat(filePath);
            return stat.size > 0;
        } catch {
            return false;
        }
    }
}