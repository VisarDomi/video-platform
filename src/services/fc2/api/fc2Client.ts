import * as path from "path";
import * as config from "../../../common/config.js";
import { FileSystemManager } from "../../../common/fileSystemManager.js";
import logger from "../../../common/logger.js";
import { IStreamProvider } from "../../core/interfaces.js";
import { MediaValidator } from "../../../common/mediaValidator.js";

export class Fc2Client implements IStreamProvider {
    private msgId = 0;

    constructor() {
        logger.info("[FC2] Client initialized.");
    }

    // ... [isOnline, getHlsUrl, _performWsHandshake logic same as before] ...

    public async isOnline(channelId: string): Promise<boolean> {
        try {
            const url = "https://live.fc2.com/api/memberApi.php";
            const body = { channel: 1, profile: 1, user: 1, streamid: channelId };
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                },
                body: new URLSearchParams(body as any),
            });
            if (!response.ok) return false;
            const json: any = await response.json();
            return json?.data?.channel_data?.is_publish > 0;
        } catch (error) { return false; }
    }

    public async getHlsUrl(channelId: string): Promise<string | null> {
        try {
            const controlUrl = "https://live.fc2.com/api/getControlServer.php";
            const params = new URLSearchParams({
                channel_id: channelId, mode: "play", client_version: "2.1.0\n+[1]",
                client_type: "pc", client_app: "browser_hls", ipv6: "",
            });
            const ctrlRes = await fetch(controlUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params });
            if (!ctrlRes.ok) return null;
            const ctrlData: any = await ctrlRes.json();
            if (!ctrlData.url || !ctrlData.control_token) return null;
            const wsUrl = `${ctrlData.url}?control_token=${ctrlData.control_token}`;
            return await this._performWsHandshake(wsUrl, channelId);
        } catch (error) { return null; }
    }

    private _performWsHandshake(wsUrl: string, channelId: string): Promise<string | null> {
        return new Promise((resolve) => {
            const ws = new WebSocket(wsUrl);
            let isResolved = false;
            const safeResolve = (val: string | null) => { if (!isResolved) { isResolved = true; resolve(val); ws.close(); } };
            const timeout = setTimeout(() => { if (!isResolved) safeResolve(null); }, 15000);
            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data as string);
                    if (msg.name === "connect_complete") {
                        this.msgId++;
                        ws.send(JSON.stringify({ name: "get_hls_information", arguments: {}, id: this.msgId }));
                    } else if (msg.name === "_response_" && msg.id === this.msgId) {
                        const lists = msg.arguments.playlists || msg.arguments.playlists_middle_latency || msg.arguments.playlists_high_latency;
                        safeResolve(lists?.[0]?.url || null);
                        clearTimeout(timeout);
                    }
                } catch (err) {}
            };
            ws.onerror = () => safeResolve(null);
            ws.onclose = () => safeResolve(null);
        });
    }

    // --- IStreamProvider Implementation ---

    public async getMasterList(masterListUrl: string): Promise<string | null> {
        try {
            const response = await fetch(masterListUrl);
            if (!response.ok) return null;
            return await response.text();
        } catch (error: any) {
            logger.error(`[FC2] getMasterList failed for ${masterListUrl}`, { error: error.message });
            return null;
        }
    }

    public async getLiveList(liveUrl: string): Promise<{ success: boolean; data: string | null }> {
        try {
            const response = await fetch(liveUrl);
            if (!response.ok) return { success: false, data: null };
            const data = await response.text();
            return { success: true, data };
        } catch (error: any) {
            return { success: false, data: null };
        }
    }

    public async getTsSegment(tsUrl: string): Promise<Buffer | null> {
        try {
            const response = await fetch(tsUrl);
            if (response.ok) {
                const arr = await response.arrayBuffer();
                return Buffer.from(arr);
            }
            return null;
        } catch (error) { return null; }
    }

    public async parseMasterPlaylist(masterUrl: string): Promise<string | null> {
        // Pass-through for FC2 (we get the direct variant URL from the WS)
        return masterUrl;
    }

    public getSegmentUrl(baseUrl: string, segmentLine: string): string {
        try {
            return new URL(segmentLine, baseUrl).href;
        } catch (e) {
            // Fallback for weird lines, though URL constructor handles relative paths
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
        const storageLocation = path.join(config.getConfig().storagePath, "fc2", "downloader");

        const storageLocationExists = await FileSystemManager.ensureDirExists(storageLocation);
        if (!storageLocationExists) {
            logger.error(`[FC2] Could not create or access storage folder at: ${storageLocation}`);
            return null;
        }

        const segmentsDirPath = path.resolve(storageLocation, baseFilename);
        const segmentsDirExists = await FileSystemManager.ensureDirExists(segmentsDirPath);
        return segmentsDirExists ? segmentsDirPath : null;
    }

    public async validateSegment(filePath: string): Promise<boolean> {
        const info = await MediaValidator.getMediaInfo(filePath);
        if (!info) return false;

        // Generic checks only for FC2
        if (isNaN(info.bitRate) || info.bitRate < 1000) return false;
        if (!isNaN(info.duration) && info.duration > 3600) return false;

        return true;
    }
}