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
        logger.info("[SC] Client initialized (FFmpeg Remux Mode).");
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

        // Wait for FFmpeg to produce at least 2 segments (so 0 is safe)
        for (let i = 0; i < 30; i++) {
            try {
                const files = await fs.readdir(controller.tempDir);
                if (files.filter(f => f.endsWith('.mkv')).length >= 2) {
                    logger.info(`[SC] [${channelId}] FFmpeg producing files. Ready.`);
                    return masterUrl;
                }
            } catch {}
            await new Promise(r => setTimeout(r, 1000));
        }

        logger.warn(`[SC] [${channelId}] Timed out waiting for FFmpeg.`);
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
            const files = await fs.readdir(controller.tempDir);
            const segments = files
                .filter(f => f.endsWith('.mkv'))
                .sort(); // seg_00000.mkv, seg_00001.mkv...

            // Exclude the last one as it might be currently being written by FFmpeg
            if (segments.length > 0) {
                segments.pop();
            }

            const duration = 2.0;

            let m3u8 = "#EXTM3U\n";
            m3u8 += "#EXT-X-VERSION:3\n";
            m3u8 += `#EXT-X-TARGETDURATION:${Math.ceil(duration)}\n`;

            // Extract seq number from filename seg_XXXXX.mkv
            const firstFile = segments[0];
            const firstSeq = firstFile ? parseInt(firstFile.match(/seg_(\d+)/)![1], 10) : 0;

            m3u8 += `#EXT-X-MEDIA-SEQUENCE:${firstSeq}\n`;

            for (const filename of segments) {
                m3u8 += `#EXTINF:${duration},\n`;
                // URL: sc_local_{channelId}_{filename}
                m3u8 += `sc_local_${channelId}_${filename}\n`;
            }

            return { success: true, data: m3u8 };
        } catch (e) {
            return { success: false, data: null };
        }
    }

    public async getTsSegment(url: string): Promise<Buffer | null> {
        // Match: sc_local_{channelId}_{filename}
        const match = url.match(/sc_local_([^_]+)_(.+)/);

        if (match) {
            const channelId = match[1];
            const filename = match[2];

            const controller = this.controllers.get(channelId);
            if (controller) {
                const filePath = path.join(controller.tempDir, filename);
                try {
                    const data = await fs.readFile(filePath);
                    return data;
                } catch {
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

    public async validateSegment(filePath: string): Promise<boolean> {
        try {
            // MKV segments generated by FFmpeg should be valid
            const stat = await fs.stat(filePath);
            return stat.size > 0;
        } catch {
            return false;
        }
    }
}