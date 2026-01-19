import logger from "../../../common/logger.js";
import { IStreamProvider } from "../../core/interfaces.js";

export class Fc2Client implements IStreamProvider {
    private msgId = 0;

    constructor() {
        logger.info("Fc2Client initialized.");
    }

    public async isOnline(channelId: string): Promise<boolean> {
        try {
            const url = "https://live.fc2.com/api/memberApi.php";
            const body = {
                channel: 1,
                profile: 1,
                user: 1,
                streamid: channelId,
            };

            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                },
                body: new URLSearchParams(body as any),
            });

            if (!response.ok) {
                logger.warn(`FC2 memberApi returned ${response.status} for ${channelId}`);
                return false;
            }

            const json: any = await response.json();
            // channel_data.is_publish > 0 means online
            return json?.data?.channel_data?.is_publish > 0;
        } catch (error: any) {
            logger.error(`Error checking isOnline for ${channelId}`, { error: error.message });
            return false;
        }
    }

    public async getHlsUrl(channelId: string): Promise<string | null> {
        try {
            // 1. Get Control Server Info
            const controlUrl = "https://live.fc2.com/api/getControlServer.php";
            const params = new URLSearchParams({
                channel_id: channelId,
                mode: "play",
                client_version: "2.1.0\n+[1]",
                client_type: "pc",
                client_app: "browser_hls",
                ipv6: "",
            });

            const ctrlRes = await fetch(controlUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: params,
            });

            if (!ctrlRes.ok) {
                logger.error(`Failed to get FC2 control server for ${channelId}`);
                return null;
            }

            const ctrlData: any = await ctrlRes.json();
            const wsBaseUrl = ctrlData.url;
            const controlToken = ctrlData.control_token;

            if (!wsBaseUrl || !controlToken) {
                logger.error(`Invalid control server response for ${channelId}`);
                return null;
            }

            // 2. Connect to WebSocket
            const wsUrl = `${wsBaseUrl}?control_token=${controlToken}`;
            return await this._performWsHandshake(wsUrl, channelId);

        } catch (error: any) {
            logger.error(`Error fetching HLS URL for ${channelId}`, { error: error.message });
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

            // Timeout after 15 seconds
            const timeout = setTimeout(() => {
                if (!isResolved) {
                    logger.warn(`FC2 WebSocket handshake timed out for ${channelId}`);
                    safeResolve(null);
                }
            }, 15000);

            ws.onopen = () => {
                // Wait for connect_complete (handled in onmessage) or just send immediately?
                // FC2 protocol: wait for 'connect_complete' then send requests.
            };

            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data as string);

                    if (msg.name === "connect_complete") {
                        // Send get_hls_information
                        this.msgId++;
                        const req = {
                            name: "get_hls_information",
                            arguments: {},
                            id: this.msgId,
                        };
                        ws.send(JSON.stringify(req));
                    } else if (msg.name === "_response_" && msg.id === this.msgId) {
                        // This is the response to our HLS request
                        const args = msg.arguments;
                        let playlistUrl: string | null = null;

                        // Priorities: playlists (usually high quality) -> playlists_middle_latency -> playlists_high_latency
                        const lists = args.playlists || args.playlists_middle_latency || args.playlists_high_latency;

                        if (lists && Array.isArray(lists) && lists.length > 0) {
                            playlistUrl = lists[0].url;
                        }

                        clearTimeout(timeout);
                        safeResolve(playlistUrl);
                    }
                } catch (err) {
                    logger.error("Error parsing FC2 WS message", { err });
                }
            };

            ws.onerror = (err) => {
                logger.error(`FC2 WebSocket error for ${channelId}`, { err });
                clearTimeout(timeout);
                safeResolve(null);
            };

            ws.onclose = () => {
                if (!isResolved) {
                    // Closed before finding URL
                    safeResolve(null);
                }
            };
        });
    }

    // --- IStreamProvider Implementation ---

    public async getMasterList(masterListUrl: string): Promise<string | null> {
        try {
            // Standard fetch, generic headers
            const response = await fetch(masterListUrl);
            if (!response.ok) return null;
            return await response.text();
        } catch (error: any) {
            logger.error(`FC2 getMasterList failed for ${masterListUrl}`, { error: error.message });
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
            logger.warn(`FC2 getLiveList failed: ${error.message}`);
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
            logger.warn(`FC2 getTsSegment status ${response.status}`);
            return null;
        } catch (error: any) {
            if (error?.message !== "terminated") {
                logger.warn(`FC2 getTsSegment network error: ${error.message}`);
            }
            return null;
        }
    }
}