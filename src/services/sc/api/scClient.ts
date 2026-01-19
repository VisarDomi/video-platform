import * as path from "path";
import * as config from "../../../common/config.js";
import { FileSystemManager } from "../../../common/fileSystemManager.js";
import logger from "../../../common/logger.js";
import { IStreamProvider } from "../../core/interfaces.js";
import { MediaValidator } from "../../../common/mediaValidator.js";
import { ScPageController } from "./scPageController.js";

export class ScClient implements IStreamProvider {
    // Map channelId -> Controller
    private controllers: Map<string, ScPageController> = new Map();

    constructor() {
        logger.info("[SC] Client initialized (Synthetic Playlist Mode).");
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
        // Return a dummy URL that contains the channelID.
        // We will use this in parseMasterPlaylist.
        return `http://synthetic-sc/${channelId}/playlist.m3u8`;
    }

    public async parseMasterPlaylist(masterUrl: string): Promise<string | null> {
        // Extract channelId from the dummy URL
        const match = masterUrl.match(/synthetic-sc\/([^\/]+)\//);
        const channelId = match ? match[1] : masterUrl;

        let controller = this.controllers.get(channelId);

        if (!controller || !controller.isActive()) {
            controller = new ScPageController(channelId);
            this.controllers.set(channelId, controller);
            await controller.start();
        }

        // Wait for at least one segment to be buffered
        for (let i = 0; i < 30; i++) {
            if (controller.getAvailableSegments().length > 0) {
                logger.info(`[SC] [${channelId}] Buffer ready.`);
                return masterUrl; // Return the same dummy URL, getLiveList handles it
            }
            await new Promise(r => setTimeout(r, 1000));
        }

        logger.warn(`[SC] [${channelId}] Timed out waiting for browser to buffer segments.`);
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
        // Extract channelId
        const match = liveUrl.match(/synthetic-sc\/([^\/]+)\//);
        const channelId = match ? match[1] : "";

        const controller = this.controllers.get(channelId);
        if (!controller || !controller.isActive()) {
            return { success: false, data: null };
        }

        const segments = controller.getAvailableSegments();
        const duration = controller.targetDuration;

        // Construct Synthetic Playlist
        let m3u8 = "#EXTM3U\n";
        m3u8 += "#EXT-X-VERSION:3\n";
        m3u8 += `#EXT-X-TARGETDURATION:${Math.ceil(duration)}\n`;

        // Sequence should match the first ID in the queue
        const firstSeq = segments.length > 0 ? segments[0] : 0;
        m3u8 += `#EXT-X-MEDIA-SEQUENCE:${firstSeq}\n`;

        for (const seqId of segments) {
            m3u8 += `#EXTINF:${duration},\n`;
            // Virtual filename: sc_seg_{channelId}_{seqId}.mp4
            m3u8 += `sc_seg_${channelId}_${seqId}.mp4\n`;
        }

        return { success: true, data: m3u8 };
    }

    public async getTsSegment(url: string): Promise<Buffer | null> {
        // Parse virtual filename: sc_seg_{channelId}_{seqId}.mp4
        // Logic handles full URL or relative path
        const match = url.match(/sc_seg_([^_]+)_(\d+)\.mp4/);

        if (match) {
            const channelId = match[1];
            const seqId = parseInt(match[2], 10);

            const controller = this.controllers.get(channelId);
            if (controller) {
                // Try specific pop
                let buf = controller.popSegment(seqId);

                // Fallback: If for some reason indices drifted or logic mismatch,
                // just give the next one to keep the stream moving.
                if (!buf) {
                    // logger.warn(`[SC] [${channelId}] Segment ${seqId} missing/out-of-order. Popping next available.`);
                    buf = controller.popNext();
                }
                return buf;
            }
        }
        return null;
    }

    public getSegmentUrl(baseUrl: string, segmentLine: string): string {
        // We just return the segment line as-is, because getTsSegment regex handles it.
        // It doesn't need to be a valid http URL.
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
        const info = await MediaValidator.getMediaInfo(filePath);
        if (!info) return false;
        if (info.duration > 0) return true;
        return false;
    }
}