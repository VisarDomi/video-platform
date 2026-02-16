import * as path from "path";
import * as config from "../../../common/config.js";
import { FileSystemManager } from "../../../common/fileSystemManager.js";
import logger from "../../../common/logger.js";
import { IStreamProvider } from "../../core/interfaces.js";
import { MediaValidator } from "../../../common/mediaValidator.js";
import { Fc2QualitySelector } from "./fc2QualitySelector.js";

interface Fc2Session {
    ws: WebSocket;
    channelId: string;
    lastAccess: number;
    heartbeatInterval: NodeJS.Timeout;
    pendingRequests: Map<number, (data: any) => void>;
}

export class Fc2Client implements IStreamProvider {
    private msgId = 0;
    private sessions: Map<string, Fc2Session> = new Map();
    private cleanupInterval: NodeJS.Timeout;

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
        // Check for stale sessions every 30 seconds
        this.cleanupInterval = setInterval(() => this._cleanupStaleSessions(), 30000);
    }

    private _cleanupStaleSessions() {
        const now = Date.now();
        const TIMEOUT_MS = 60000; // 60 seconds without access = stale

        for (const [channelId, session] of this.sessions.entries()) {
            if (now - session.lastAccess > TIMEOUT_MS) {
                logger.info(`[FC2] Session for ${channelId} timed out. Closing WebSocket.`);
                this._closeSession(channelId);
            }
        }
    }

    private _closeSession(channelId: string) {
        const session = this.sessions.get(channelId);
        if (session) {
            clearInterval(session.heartbeatInterval);
            try {
                session.ws.close();
            } catch (e) { /* ignore */ }
            this.sessions.delete(channelId);
        }
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

            logger.debug(`[FC2] memberApi response for ${channelId}: is_publish=${json?.data?.channel_data?.is_publish}`);

            const isPublish = json?.data?.channel_data?.is_publish > 0;
            if (!isPublish) {
                logger.debug(`[FC2] Channel ${channelId} is offline`);
            }
            return isPublish;
        } catch (error: any) {
            logger.error(`[FC2] Error checking isOnline for ${channelId}`, { error: error.message });
            return false;
        }
    }

    private _performWsHandshake(wsUrl: string, channelId: string): Promise<string | null> {
        return new Promise((resolve) => {
            // Close existing session if any
            this._closeSession(channelId);

            const ws = new WebSocket(wsUrl);
            let isResolved = false;
            const pendingRequests = new Map<number, (data: any) => void>();

            const safeResolve = (val: string | null) => {
                if (!isResolved) {
                    isResolved = true;
                    if (!val) {
                        // If failed, close the socket
                        try { ws.close(); } catch (e) {}
                    }
                    resolve(val);
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
                        // Store the ID for the initial handshake request so we can track it if needed,
                        // though here we just rely on _response_ logic below for the handshake
                        ws.send(JSON.stringify({ name: "get_hls_information", arguments: {}, id: this.msgId }));
                    }
                    else if (msg.name === "_response_") {
                        const reqId = msg.id;

                        // Check if this is a pending request for polling
                        if (pendingRequests.has(reqId)) {
                            const callback = pendingRequests.get(reqId);
                            if (callback) callback(msg.arguments);
                            pendingRequests.delete(reqId);
                            return;
                        }

                        // Handle Initial Handshake Response
                        if (reqId === this.msgId && !isResolved) {
                            const best = Fc2QualitySelector.selectBestPlaylist(msg.arguments);

                            if (best) {
                                logger.info(`[FC2] Resolved HLS URL for ${channelId}: ${best.url}`);

                                // Start Heartbeat
                                const heartbeatInterval = setInterval(() => {
                                    try {
                                        this.msgId++;
                                        ws.send(JSON.stringify({ name: "heartbeat", arguments: {}, id: this.msgId }));
                                    } catch (e) {
                                        logger.warn(`[FC2] Failed to send heartbeat for ${channelId}`);
                                    }
                                }, 30000);

                                // Store Session
                                this.sessions.set(channelId, {
                                    ws,
                                    channelId,
                                    lastAccess: Date.now(),
                                    heartbeatInterval,
                                    pendingRequests
                                });

                                clearTimeout(timeout);
                                safeResolve(best.url);
                            } else {
                                logger.warn(`[FC2] No suitable playlists found in WS response for ${channelId}`);
                                clearTimeout(timeout);
                                safeResolve(null);
                            }
                        }
                    }
                } catch (err) {
                    logger.error(`[FC2] WS Parse Error`, { err });
                }
            };

            ws.onerror = (e) => {
                logger.error(`[FC2] WebSocket error for ${channelId}`, { error: (e as any).message });
                safeResolve(null);
            };

            ws.onclose = () => {
                if (this.sessions.has(channelId)) {
                    logger.info(`[FC2] WebSocket closed remotely for ${channelId}`);
                    this._closeSession(channelId);
                }
                safeResolve(null);
            };
        });
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

    public async getMasterList(masterListUrl: string): Promise<string | null> {
        try {
            this._touchSession(masterListUrl);
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
            this._touchSession(liveUrl);
            const response = await this._request(liveUrl);
            if (!response.ok) {
                logger.debug(`[FC2] getLiveList failed: ${response.status} ${response.statusText}`);
                return { success: false, data: null };
            }
            const data = await response.text();
            return { success: true, data };
        } catch (error: any) {
            logger.error(`[FC2] getLiveList exception`, { error: error.message, liveUrl });
            return { success: false, data: null };
        }
    }

    public async getTsSegment(tsUrl: string): Promise<Buffer | null> {
        try {
            this._touchSession(tsUrl);
            const response = await this._request(tsUrl);
            if (response.ok) {
                const arr = await response.arrayBuffer();
                return Buffer.from(arr);
            }
            logger.warn(`[FC2] Segment download failed: ${response.status} ${response.statusText}`, { tsUrl });
            return null;
        } catch (error) { return null; }
    }

    /**
     * Extracts Channel ID from URL and updates lastAccess for the active session.
     */
    private _touchSession(url: string) {
        // Expected format: /stream/53302993/
        const match = url.match(/\/stream\/(\d+)\//);
        if (match && match[1]) {
            const channelId = match[1];
            const session = this.sessions.get(channelId);
            if (session) {
                session.lastAccess = Date.now();
            }
        }
    }

    private _extractChannelId(url: string): string | null {
        // Handle https://live.fc2.com/123456/ (Discovery) or HLS URL structure
        const match = url.match(/live\.fc2\.com\/(\d+)/) || url.match(/\/stream\/(\d+)\//);
        return match ? match[1] : null;
    }

    public async pollCurrentVariant(masterUrl: string, currentLiveUrl: string): Promise<string | null> {
        // For FC2, masterUrl in our system is usually the channel/stream HLS Base,
        // but we can extract channel ID from it or the currentLiveUrl.
        const channelId = this._extractChannelId(masterUrl) || this._extractChannelId(currentLiveUrl);

        if (!channelId) return null;

        const session = this.sessions.get(channelId);
        if (!session) return null; // No active WS session

        session.lastAccess = Date.now();

        return new Promise((resolve) => {
            this.msgId++;
            const reqId = this.msgId;

            // Timeout for poll
            const timeout = setTimeout(() => {
                session.pendingRequests.delete(reqId);
                resolve(null);
            }, 5000);

            session.pendingRequests.set(reqId, (args: any) => {
                clearTimeout(timeout);
                const best = Fc2QualitySelector.selectBestPlaylist(args);
                if (best && best.url !== currentLiveUrl) {
                    resolve(best.url);
                } else {
                    resolve(null);
                }
            });

            try {
                session.ws.send(JSON.stringify({ name: "get_hls_information", arguments: {}, id: reqId }));
            } catch (e) {
                session.pendingRequests.delete(reqId);
                resolve(null);
            }
        });
    }

    public async parseMasterPlaylist(masterUrl: string): Promise<string | null> {
        // Logic handled in getHlsUrl (which performs the WS handshake and selection)
        // If masterUrl comes in as a standard http URL, we might treat it normally,
        // but for FC2 in this architecture, the 'masterUrl' passed to StreamDownloader
        // was actually the result of `getHlsUrl` (which is the variant).
        // However, if we are adhering to the interface strictly:

        // If it looks like an FC2 HLS URL already, return it.
        if (masterUrl.includes(".m3u8")) {
            return masterUrl;
        }

        // Otherwise try to download as text
        const content = await this.getMasterList(masterUrl);
        if (!content) return null;

        if (content.includes("#EXT-X-STREAM-INF")) {
            logger.info(`[FC2] Detected Master Playlist. Parsing for best variant...`);
            const lines = content.split("\n");
            let bestVariantUrl: string | null = null;

            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
                    if (i + 1 < lines.length) {
                        const variantLine = lines[i+1].trim();
                        if (variantLine && !variantLine.startsWith("#")) {
                            bestVariantUrl = this.getSegmentUrl(masterUrl, variantLine);
                            break;
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

    public async reconnect(streamerId: string): Promise<string | null> {
        logger.info(`[FC2] Reconnecting for ${streamerId}...`);
        return this.getHlsUrl(streamerId);
    }

    public async validateSegment(filePath: string): Promise<boolean> {
        const info = await MediaValidator.getMediaInfo(filePath);
        if (!info) return false;

        if (isNaN(info.bitRate) || info.bitRate < 1000) return false;
        if (!isNaN(info.duration) && info.duration > 3600) return false;

        return true;
    }
}