import * as path from "path";
import * as config from "../../../common/config.js";
import { FileSystemManager } from "../../../common/fileSystemManager.js";
import logger from "../../../common/logger.js";
import { IStreamProvider } from "../../core/interfaces.js";
import { MediaValidator } from "../../../common/mediaValidator.js";

export class Fc2Client implements IStreamProvider {
    private msgId = 0;

    private readonly HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://live.fc2.com/",
        "Origin": "https://live.fc2.com",
        "Connection": "keep-alive",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "*/*"
    };

    constructor() {
        logger.info("[FC2] Client initialized.");
    }

    private async _request(url: string, options: RequestInit = {}): Promise<Response> {
        const headers = { ...this.HEADERS, ...(options.headers || {}) };
        return fetch(url, { ...options, headers });
    }

    public async isOnline(channelId: string): Promise<boolean> {
        try {
            const url = "https://live.fc2.com/api/memberApi.php";
            const body = { channel: 1, profile: 1, user: 1, streamid: channelId };

            logger.debug(`[FC2] Checking status for ${channelId}...`);

            const response = await this._request(url, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams(body as any),
            });

            if (!response.ok) {
                logger.warn(`[FC2] memberApi returned ${response.status} for ${channelId}`);
                return false;
            }

            const json: any = await response.json();
            logger.debug(`[FC2] memberApi response for ${channelId}:`, { data: json?.data?.channel_data });

            const isPublish = json?.data?.channel_data?.is_publish > 0;
            if (!isPublish) {
                logger.debug(`[FC2] Channel ${channelId} is offline (is_publish=${json?.data?.channel_data?.is_publish})`);
            }
            return isPublish;
        } catch (error: any) {
            logger.error(`[FC2] Error checking isOnline for ${channelId}`, { error: error.message });
            return false;
        }
    }

    public async getHlsUrl(channelId: string): Promise<string | null> {
        try {
            const controlUrl = "https://live.fc2.com/api/getControlServer.php";
            const params = new URLSearchParams({
                channel_id: channelId, mode: "play", client_version: "2.1.0\n+[1]",
                client_type: "pc", client_app: "browser_hls", ipv6: "",
            });

            const ctrlRes = await this._request(controlUrl, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: params,
            });

            if (!ctrlRes.ok) {
                logger.error(`[FC2] Failed to get FC2 control server for ${channelId} (Status: ${ctrlRes.status})`);
                return null;
            }

            const ctrlData: any = await ctrlRes.json();
            if (!ctrlData.url || !ctrlData.control_token) {
                logger.warn(`[FC2] Invalid control response for ${channelId}`, ctrlData);
                return null;
            }

            const wsUrl = `${ctrlData.url}?control_token=${ctrlData.control_token}`;
            return await this._performWsHandshake(wsUrl, channelId);
        } catch (error: any) {
            logger.error(`[FC2] Error fetching HLS URL for ${channelId}`, { error: error.message });
            return null;
        }
    }

    private _performWsHandshake(wsUrl: string, channelId: string): Promise<string | null> {
        return new Promise((resolve) => {
            const ws = new WebSocket(wsUrl);
            let isResolved = false;

            const safeResolve = (val: string | null) => {
                if (!isResolved) {
                    isResolved = true;
                    resolve(val);
                    ws.close();
                }
            };

            const timeout = setTimeout(() => {
                if (!isResolved) {
                    logger.warn(`[FC2] WebSocket handshake timed out for ${channelId}`);
                    safeResolve(null);
                }
            }, 15000);

            ws.onopen = () => {
                logger.debug(`[FC2] WebSocket connected for ${channelId}`);
            };

            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data as string);
                    if (msg.name === "connect_complete") {
                        this.msgId++;
                        ws.send(JSON.stringify({ name: "get_hls_information", arguments: {}, id: this.msgId }));
                    } else if (msg.name === "_response_" && msg.id === this.msgId) {
                        const lists = msg.arguments.playlists || msg.arguments.playlists_middle_latency || msg.arguments.playlists_high_latency;
                        const url = lists?.[0]?.url || null;

                        if (url) {
                            logger.info(`[FC2] Resolved HLS URL for ${channelId}`);
                        } else {
                            logger.warn(`[FC2] No playlists found in WS response for ${channelId}`);
                        }

                        safeResolve(url);
                        clearTimeout(timeout);
                    }
                } catch (err) {
                    logger.error(`[FC2] WS Parse Error`, { err });
                }
            };

            ws.onerror = (e) => {
                logger.error(`[FC2] WebSocket error for ${channelId}`, { error: (e as any).message });
                safeResolve(null);
            };
            ws.onclose = () => safeResolve(null);
        });
    }

    // --- IStreamProvider Implementation ---

    public async getMasterList(masterListUrl: string): Promise<string | null> {
        try {
            const response = await this._request(masterListUrl);
            if (!response.ok) return null;
            return await response.text();
        } catch (error: any) {
            logger.error(`[FC2] getMasterList failed for ${masterListUrl}`, { error: error.message });
            return null;
        }
    }

    public async getLiveList(liveUrl: string): Promise<{ success: boolean; data: string | null }> {
        try {
            const response = await this._request(liveUrl);
            if (!response.ok) return { success: false, data: null };
            const data = await response.text();
            return { success: true, data };
        } catch (error: any) {
            return { success: false, data: null };
        }
    }

    public async getTsSegment(tsUrl: string): Promise<Buffer | null> {
        try {
            const response = await this._request(tsUrl);
            if (response.ok) {
                const arr = await response.arrayBuffer();
                return Buffer.from(arr);
            }
            logger.warn(`[FC2] Segment download failed: ${response.status} ${response.statusText}`, { tsUrl });
            return null;
        } catch (error) { return null; }
    }

    public async parseMasterPlaylist(masterUrl: string): Promise<string | null> {
        // Fetch the content to check if it is a Master Playlist
        const content = await this.getMasterList(masterUrl);
        if (!content) return null;

        if (content.includes("#EXT-X-STREAM-INF")) {
            logger.info(`[FC2] Detected Master Playlist. Parsing for best variant...`);
            // Parse Master Playlist
            const lines = content.split("\n");
            let bestVariantUrl: string | null = null;

            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
                    // The next line is the URL
                    if (i + 1 < lines.length) {
                        const variantLine = lines[i+1].trim();
                        if (variantLine && !variantLine.startsWith("#")) {
                            bestVariantUrl = this.getSegmentUrl(masterUrl, variantLine);
                            break; // Just pick the first one (highest quality usually listed first in Adaptive)
                        }
                    }
                }
            }

            if (bestVariantUrl) {
                logger.info(`[FC2] Selected variant: ${bestVariantUrl}`);
                return bestVariantUrl;
            } else {
                logger.warn(`[FC2] Failed to parse variant from Master Playlist. Using original URL.`);
            }
        }

        // If not a master playlist, or failed to parse, assume it's a Media Playlist
        return masterUrl;
    }

    public getSegmentUrl(baseUrl: string, segmentLine: string): string {
        try {
            return new URL(segmentLine, baseUrl).href;
        } catch (e) {
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

        if (isNaN(info.bitRate) || info.bitRate < 1000) return false;
        if (!isNaN(info.duration) && info.duration > 3600) return false;

        return true;
    }
}