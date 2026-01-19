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
    // Helper to map a playlist/segment URL back to a channel ID if needed
    // (though currently we handle mapping via logic)

    constructor() {
        logger.info("[SC] Client initialized (Persistent Browser Mode).");
    }

    public async isOnline(channelId: string): Promise<boolean> {
        // Keep the lightweight API check for Discovery
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
        // We return the Channel ID (or Page URL) as the "Master URL".
        // The Downloader will pass this back to parseMasterPlaylist.
        return channelId;
    }

    public async parseMasterPlaylist(masterUrl: string): Promise<string | null> {
        // In this architecture, 'masterUrl' is the channelId we returned in getHlsUrl
        const channelId = masterUrl;

        let controller = this.controllers.get(channelId);

        if (!controller || !controller.isActive()) {
            controller = new ScPageController(channelId);
            this.controllers.set(channelId, controller);
            await controller.start();
        }

        // Wait for the first playlist interception
        // Poll for 30 seconds
        for (let i = 0; i < 30; i++) {
            const data = controller.getLatestPlaylist();
            if (data) {
                logger.info(`[SC] [${channelId}] Locked onto playlist: ${data.url}`);
                return data.url;
            }
            await new Promise(r => setTimeout(r, 1000));
        }

        logger.warn(`[SC] [${channelId}] Timed out waiting for browser to intercept M3U8.`);
        await controller.stop();
        this.controllers.delete(channelId);
        return null;
    }

    public async pollCurrentVariant(masterUrl: string, currentLiveUrl: string): Promise<string | null> {
        // Not used in this mode, logic handled internally by the browser
        return null;
    }

    public async getMasterList(url: string): Promise<string | null> {
        // Not used
        return null;
    }

    public async getLiveList(liveUrl: string): Promise<{ success: boolean; data: string | null }> {
        // We need to find which controller owns this URL.
        // Since we don't store the mapping explicitly in a global map,
        // we iterate active controllers. There are usually very few (0-10).

        for (const [channelId, controller] of this.controllers) {
            const data = controller.getLatestPlaylist();
            // We return the content regardless of URL match strictly,
            // assuming the StreamDownloader is asking for the stream we are tracking.
            // But to be safe, we check if the controller is active.
            if (data) {
                // If we want to be strict: if (data.url === liveUrl) ...
                // But the liveUrl might change due to token rotation.
                // We rely on the fact that StreamDownloader calls this for a specific handle.
                // However, StreamDownloader doesn't pass the handle here, just the URL.

                // Heuristic: If the liveUrl matches the one the controller has, OR
                // if we just assume 1:1 mapping if the URL is part of the same domain.
                // Let's iterate and see if the controller's latest URL matches.
                if (data.url === liveUrl) {
                    return { success: true, data: data.content };
                }
            }
        }

        // Fallback: If URL changed, maybe we just return the latest from ANY controller
        // that matches the domain? No, that's dangerous.

        // Better Approach: getLiveList is called by StreamDownloader.
        // StreamDownloader obtained 'liveUrl' from 'parseMasterPlaylist'.
        // We returned the intercepted URL there.
        // So the first call will match. Subsequent calls might not if the browser updates the URL.
        // But StreamDownloader keeps using the old URL unless we tell it to switch.

        // FIX: We iterate all controllers. If any controller has a playlist, we return it
        // IF the url requested matches what we have OR if we can infer it.
        // Actually, StreamDownloader updates its local 'liveUrl' if we use the QualityMonitor,
        // but we aren't using that here.

        // Simple logic: Scan for exact match.
        for (const controller of this.controllers.values()) {
            const data = controller.getLatestPlaylist();
            if (data && data.url === liveUrl) {
                return { success: true, data: data.content };
            }
        }

        // If exact match fails (maybe token rotated), we might check if the base path matches?
        // For now, return false. StreamDownloader will retry.
        // If the browser rotated the URL, StreamDownloader is out of sync.
        // This architecture usually requires StreamDownloader to be aware of the new URL.
        // BUT, since we just need the CONTENT, and the content contains the segments...

        // HACK: Since we can't easily identify which channel 'liveUrl' belongs to if it doesn't match,
        // we might fail here. However, SC tokens are usually sticky for the session.
        return { success: false, data: null };
    }

    public async getTsSegment(url: string): Promise<Buffer | null> {
        // Check all controllers for this segment
        for (const controller of this.controllers.values()) {
            const buffer = controller.getSegment(url);
            if (buffer) return buffer;
        }
        return null;
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
        // If Playwright intercepted it, it's likely valid.
        // We perform a basic check.
        const info = await MediaValidator.getMediaInfo(filePath);
        if (!info) return false;
        if (info.duration > 0) return true;
        return false;
    }
}