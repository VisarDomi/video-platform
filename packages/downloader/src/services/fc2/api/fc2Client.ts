import * as path from "path";
import { config } from "../../../common/config.js";
import { FileSystemManager } from "../../../common/fileSystemManager.js";
import logger from "../../../common/logger.js";
import { IDownloadSession, IStreamProvider } from "../../core/interfaces.js";
import { MediaValidator } from "../../../common/mediaValidator.js";
import { Fc2QualitySelector } from "./fc2QualitySelector.js";
import { CDN_FETCH_TIMEOUT_MS } from "../../../common/timing.js";
import { FC2_SESSION_CLEANUP_INTERVAL_MS, FC2_SESSION_STALE_MS, FC2_WS_HANDSHAKE_TIMEOUT_MS, FC2_WS_HEARTBEAT_INTERVAL_MS } from "../../../common/timing.js";

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
    private paidChannels = new Set<string>();

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
        this.cleanupInterval = setInterval(() => this._cleanupStaleSessions(), FC2_SESSION_CLEANUP_INTERVAL_MS);
    }

    private _cleanupStaleSessions() {
        const now = Date.now();
        const TIMEOUT_MS = FC2_SESSION_STALE_MS;

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
            } catch (e) {}
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

            const channelData = json?.data?.channel_data;
            const isPublish = channelData?.is_publish > 0;
            const isPaid = channelData?.fee > 0;

            if (!isPublish) {
                logger.debug(`[FC2] ${channelId}: offline (is_publish=${channelData?.is_publish})`);
                if (this.paidChannels.has(channelId)) {
                    logger.info(`[FC2] ${channelId}: no longer live (was paid)`);
                    this.paidChannels.delete(channelId);
                }
                return false;
            }
            if (isPaid) {
                if (!this.paidChannels.has(channelId)) {
                    logger.info(`[FC2] ${channelId}: live but paid (fee=${channelData?.fee}) — skipping`);
                    this.paidChannels.add(channelId);
                }
                return false;
            }

            if (this.paidChannels.has(channelId)) {
                logger.info(`[FC2] ${channelId}: transitioned from paid to free`);
                this.paidChannels.delete(channelId);
            }
            return true;
        } catch (error: any) {
            logger.error(`[FC2] Error checking isOnline for ${channelId}`, { error: error.message });
            return false;
        }
    }

    private _performWsHandshake(wsUrl: string, channelId: string): Promise<string | null> {
        return new Promise((resolve) => {
            this._closeSession(channelId);

            const ws = new WebSocket(wsUrl);
            let isResolved = false;
            const pendingRequests = new Map<number, (data: any) => void>();

            const safeResolve = (val: string | null) => {
                if (!isResolved) {
                    isResolved = true;
                    if (!val) {
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
            }, FC2_WS_HANDSHAKE_TIMEOUT_MS);

            ws.onopen = () => {
                logger.debug(`[FC2] WebSocket connected for ${channelId}`);
            };

            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data as string);

                    if (msg.name === "connect_complete") {
                        this.msgId++;
                        ws.send(JSON.stringify({ name: "get_hls_information", arguments: {}, id: this.msgId }));
                    }
                    else if (msg.name === "_response_") {
                        const reqId = msg.id;

                        if (pendingRequests.has(reqId)) {
                            const callback = pendingRequests.get(reqId);
                            if (callback) callback(msg.arguments);
                            pendingRequests.delete(reqId);
                            return;
                        }

                        if (reqId === this.msgId && !isResolved) {
                            const best = Fc2QualitySelector.selectBestPlaylist(msg.arguments);

                            if (best) {
                                logger.info(`[FC2] Resolved HLS URL for ${channelId}: ${best.url}`);

                                const heartbeatInterval = setInterval(() => {
                                    try {
                                        this.msgId++;
                                        ws.send(JSON.stringify({ name: "heartbeat", arguments: {}, id: this.msgId }));
                                    } catch (e) {
                                        logger.warn(`[FC2] Failed to send heartbeat for ${channelId}`);
                                    }
                                }, FC2_WS_HEARTBEAT_INTERVAL_MS);

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
                } else if (!isResolved) {
                    logger.warn(`[FC2] WebSocket closed during handshake for ${channelId}`);
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
            const hlsUrl = await this._performWsHandshake(wsUrl, channelId);
            if (!hlsUrl) {
                logger.warn(`[FC2] ${channelId}: WebSocket handshake completed but no HLS URL returned`);
            }
            return hlsUrl;
        } catch (error: any) {
            logger.error(`[FC2] Error fetching HLS URL for ${channelId}`, { error: error.message });
            return null;
        }
    }

    public async getMasterList(masterListUrl: string): Promise<string | null> {
        try {
            this._touchSession(masterListUrl);
            const response = await this._request(masterListUrl);
            if (!response.ok) {
                logger.warn(`[FC2] getMasterList ${response.status} ${response.statusText} url=${masterListUrl}`);
                return null;
            }
            return await response.text();
        } catch (error: any) {
            logger.error(`[FC2] getMasterList failed for ${masterListUrl}`, { error: error.message });
            return null;
        }
    }

    public createDownloadSession(): IDownloadSession {
        return new Fc2DownloadSession(this);
    }

    public _touchSession(url: string) {
        const match = url.match(/\/stream\/(\d+)\//);
        if (match && match[1]) {
            const channelId = match[1];
            const session = this.sessions.get(channelId);
            if (session) {
                session.lastAccess = Date.now();
            }
        }
    }

    public async parseMasterPlaylist(masterUrl: string): Promise<string | null> {

        if (masterUrl.includes(".m3u8")) {
            return masterUrl;
        }

        const content = await this.getMasterList(masterUrl);
        if (!content) {
            logger.warn(`[FC2] parseMasterPlaylist: getMasterList returned empty for ${masterUrl.split("?")[0]}`);
            return null;
        }

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
        const storageLocation = path.join(config.storagePath, "fc2", "downloader");

        const storageLocationExists = await FileSystemManager.ensureDirExists(storageLocation);
        if (!storageLocationExists) {
            logger.error(`[FC2] Could not create or access storage folder at: ${storageLocation}`);
            return null;
        }

        const segmentsDirPath = path.resolve(storageLocation, baseFilename);
        const segmentsDirExists = await FileSystemManager.ensureDirExists(segmentsDirPath);
        return segmentsDirExists ? segmentsDirPath : null;
    }

    public async validateSegment(filePath: string): Promise<{ valid: boolean; duration?: number }> {
        const name = path.basename(filePath);
        const info = await MediaValidator.getMediaInfo(filePath);
        if (!info) {
            logger.warn(`[FC2] validateSegment: ffprobe failed for ${name}`);
            return { valid: false };
        }

        if (isNaN(info.bitRate) || info.bitRate < 1000) {
            logger.warn(`[FC2] validateSegment: bad bitrate ${info.bitRate} for ${name}`);
            return { valid: false };
        }
        if (!isNaN(info.duration) && info.duration > 3600) {
            logger.warn(`[FC2] validateSegment: duration ${info.duration}s too long for ${name}`);
            return { valid: false };
        }

        return { valid: true, duration: info.duration };
    }

    public async recoverVariant(_masterPlaylistUrl: string): Promise<string | null> {
        return null;
    }

    public async shouldRetry(context: import("../../core/interfaces.js").DownloadExitContext): Promise<string | null> {
        if (context.exitReason === "aborted") return null;

        const isLive = await this.isOnline(context.streamerId);
        if (!isLive) {
            logger.info(`[FC2] ${context.streamerId}: shouldRetry=no (offline or paid after ${context.exitReason})`);
            return null;
        }

        const url = await this.getHlsUrl(context.streamerId);
        if (!url) {
            logger.warn(`[FC2] ${context.streamerId}: shouldRetry=no (getHlsUrl failed, stream is live)`);
        }
        return url;
    }
}

class Fc2DownloadSession implements IDownloadSession {
    private client: Fc2Client;
    private readonly HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://live.fc2.com/",
        "Origin": "https://live.fc2.com",
        "Connection": "keep-alive",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "*/*"
    };

    constructor(client: Fc2Client) {
        this.client = client;
    }

    private static readonly FETCH_TIMEOUT_MS = CDN_FETCH_TIMEOUT_MS;

    public async fetchPlaylist(url: string): Promise<string | null> {
        try {
            this.client._touchSession(url);
            const response = await fetch(url, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(Fc2DownloadSession.FETCH_TIMEOUT_MS),
            });
            if (!response.ok) {
                logger.warn(`[FC2] Playlist fetch failed: ${response.status} ${response.statusText} url=${url}`);
                return null;
            }
            return await response.text();
        } catch (error: any) {
            logger.error(`[FC2] Playlist fetch error: ${url}`, { error: error.message });
            return null;
        }
    }

    public async fetchSegment(tsUrl: string): Promise<import("../../core/interfaces.js").SegmentFetchResult> {
        try {
            this.client._touchSession(tsUrl);
            const response = await fetch(tsUrl, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(Fc2DownloadSession.FETCH_TIMEOUT_MS),
            });
            if (response.ok) {
                const arr = await response.arrayBuffer();
                return { data: Buffer.from(arr) };
            }
            logger.warn(`[FC2] Segment download failed: ${response.status} ${response.statusText}`, { tsUrl });
            return { data: null, retryable: false };
        } catch (error: any) {
            logger.warn(`[FC2] Segment fetch error: ${error.message}`, { tsUrl });
            return { data: null, retryable: true };
        }
    }
}