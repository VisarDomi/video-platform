import * as path from "path";
import * as config from "../../../common/config.js";
import { FileSystemManager } from "../../../common/fileSystemManager.js";
import logger from "../../../common/logger.js";
import { IStreamProvider } from "../../core/interfaces.js";
import { MediaValidator } from "../../../common/mediaValidator.js";
import { ScPageController } from "./scPageController.js";

export class ScClient implements IStreamProvider {
    private controllers: Map<string, ScPageController> = new Map();

    constructor() {
        logger.info("[SC] Client initialized (Stream Recorder Mode).");
    }

    public async isOnline(channelId: string): Promise<boolean> {
        try {
            const url = `https://stripchat.com/api/front/v2/models/username/${channelId}/cam`;
            const response = await fetch(url, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36"
                }
            });
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

        // Wait for buffer
        for (let i = 0; i < 30; i++) {
            if (controller.getAvailableSegments().length > 0) {
                logger.info(`[SC] [${channelId}] Recorder active. Buffer ready.`);
                return masterUrl;
            }
            await new Promise(r => setTimeout(r, 1000));
        }

        logger.warn(`[SC] [${channelId}] Timed out waiting for recorder.`);
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
        if (!controller || !controller.isActive()) {
            return { success: false, data: null };
        }

        const segments = controller.getAvailableSegments();
        const duration = 2.0;

        let m3u8 = "#EXTM3U\n";
        m3u8 += "#EXT-X-VERSION:3\n";
        m3u8 += `#EXT-X-TARGETDURATION:${Math.ceil(duration)}\n`;

        const firstSeq = segments.length > 0 ? segments[0] : 0;
        m3u8 += `#EXT-X-MEDIA-SEQUENCE:${firstSeq}\n`;

        for (const seqId of segments) {
            m3u8 += `#EXTINF:${duration},\n`;
            // Change extension to .mp4. If the browser sends mp4, good.
            // If it sends WebM, we name it .mp4 anyway to trick HLS players?
            // No, that confuses demuxers.
            // If we successfully get mp4 from browser, we name it .mp4.
            // If we get WebM, we name it .webm and assume the user concatenates manually (since HLS player won't support it).
            // Let's stick to .mp4 naming in the hope that `MediaRecorderInMP4` flag works.
            m3u8 += `sc_seg_${channelId}_${seqId}.mp4\n`;
        }

        return { success: true, data: m3u8 };
    }

    public async getTsSegment(url: string): Promise<Buffer | null> {
        // Regex matches .mp4 now
        const match = url.match(/sc_seg_(.+)_(\d+)\.mp4/);

        if (match) {
            const channelId = match[1];
            const seqId = parseInt(match[2], 10);

            const controller = this.controllers.get(channelId);
            if (controller) {
                let buf = controller.popSegment(seqId);
                if (!buf) {
                    buf = controller.popNext();
                }
                return buf;
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

        const storageLocationExists = await FileSystemManager.ensureDirExists(storageLocation);
        if (!storageLocationExists) return null;

        const segmentsDirPath = path.resolve(storageLocation, baseFilename);
        const segmentsDirExists = await FileSystemManager.ensureDirExists(segmentsDirPath);
        return segmentsDirExists ? segmentsDirPath : null;
    }

    public async validateSegment(filePath: string): Promise<boolean> {
        try {
            const stat = await import("fs/promises").then(fs => fs.stat(filePath));
            return stat.size > 0;
        } catch {
            return false;
        }
    }
}