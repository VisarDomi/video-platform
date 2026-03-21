import * as fs from "fs/promises";
import * as path from "path";
import * as config from "../../../common/config.js";
import { FileSystemManager } from "../../../common/fileSystemManager.js";
import logger from "../../../common/logger.js";
import { IDownloadSession, IStreamProvider } from "../../core/interfaces.js";
import { decryptM3u8, getMouflonUrlParams, loadMouflonKeys } from "./mouflonDecoder.js";

function parseFmp4Duration(data: Buffer): number {
    let pos = 0;
    const trackDurations = new Map<number, number>();

    while (pos + 8 <= data.length) {
        const size = data.readUInt32BE(pos);
        if (size < 8) break;

        const boxType = data.subarray(pos + 4, pos + 8).toString("ascii");
        if (boxType === "sidx" && pos + 40 <= data.length) {
            const version = data[pos + 8];
            if (version === 1) {
                const timescale = data.readUInt32BE(pos + 16);
                const refCount = data.readUInt16BE(pos + 38);
                let offset = pos + 40;
                for (let i = 0; i < refCount; i++) {
                    if (offset + 12 > data.length) break;
                    const ticks = trackDurations.get(timescale) ?? 0;
                    trackDurations.set(timescale, ticks + data.readUInt32BE(offset + 4));
                    offset += 12;
                }
            }
        }
        pos += size;
    }

    if (trackDurations.size === 0) return 0;

    let maxDuration = 0;
    for (const [timescale, ticks] of trackDurations) {
        const duration = ticks / timescale;
        if (duration > maxDuration) maxDuration = duration;
    }
    return Math.round(maxDuration * 1000) / 1000;
}

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const CDN_TLDS = ["org", "com", "net"];
const BULK_BATCH_SIZE = 100;

export class ScClient implements IStreamProvider {
    private roomIdCache = new Map<string, string>();
    private cookies: string[] = [];

    constructor() {
        logger.info("[SC] ScClient initialized.");
    }

    public async init(): Promise<void> {
        await loadMouflonKeys();
    }

    private getHeaders(): Record<string, string> {
        const headers: Record<string, string> = { "User-Agent": USER_AGENT };
        if (this.cookies.length > 0) {
            headers["Cookie"] = this.cookies.join("; ");
        }
        return headers;
    }

    private async fetchText(url: string): Promise<{ ok: boolean; status: number; text: string; cookies: string[] }> {
        try {
            const response = await fetch(url, { headers: this.getHeaders() });
            const setCookies: string[] = [];
            const raw = response.headers.getSetCookie?.() ?? [];
            for (const c of raw) {
                const name = c.split(";")[0];
                if (name) setCookies.push(name);
            }
            return {
                ok: response.ok,
                status: response.status,
                text: await response.text(),
                cookies: setCookies,
            };
        } catch (error: any) {
            logger.error(`[SC] Fetch failed: ${url}`, { error: error.message });
            return { ok: false, status: 0, text: "", cookies: [] };
        }
    }

    private async fetchJson<T>(url: string): Promise<T | null> {
        const result = await this.fetchText(url);
        if (!result.ok) return null;
        try {
            return JSON.parse(result.text) as T;
        } catch {
            logger.warn(`[SC] Failed to parse JSON from ${url}`);
            return null;
        }
    }

    private accumulateCookies(newCookies: string[]): void {
        const map = new Map<string, string>();
        for (const c of this.cookies) {
            const name = c.split("=")[0];
            map.set(name, c);
        }
        for (const c of newCookies) {
            const name = c.split("=")[0];
            map.set(name, c);
        }
        this.cookies = Array.from(map.values());
    }

    public resetSession(): void {
        logger.warn("[SC] Resetting HTTP session (clearing cookies)");
        this.cookies = [];
    }

    private static uniq(length = 16): string {
        const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
        let result = "";
        for (let i = 0; i < length; i++) {
            result += chars[Math.floor(Math.random() * chars.length)];
        }
        return result;
    }

    private async fetchCamData(username: string): Promise<{ roomId: string; streamName: string; isCamAvailable: boolean; isCamActive: boolean } | null> {
        const url = `https://stripchat.com/api/front/v2/models/username/${username}/cam?uniq=${ScClient.uniq()}`;
        const data = await this.fetchJson<any>(url);
        if (!data) return null;

        if (!data.user?.user?.id) {
            if (data.error === "Not Found") {
                logger.warn(`[SC] User ${username} not found`);
            }
            return null;
        }

        const roomId = String(data.user.user.id);
        this.roomIdCache.set(username, roomId);

        const streamName = data.cam?.streamName || roomId;
        const isCamAvailable = data.cam?.isCamAvailable ?? false;
        const isCamActive = data.cam?.isCamActive ?? false;

        return { roomId, streamName, isCamAvailable, isCamActive };
    }

    public async resolveRoomId(username: string): Promise<string | null> {
        const cachedRoomId = this.roomIdCache.get(username);
        if (cachedRoomId) return cachedRoomId;

        const result = await this.fetchCamData(username);
        return result?.roomId ?? null;
    }

    public async refreshStreamName(username: string): Promise<string | null> {
        const result = await this.fetchCamData(username);
        if (!result) return null;

        if (!result.isCamAvailable || !result.isCamActive) {
            logger.debug(`[SC] ${username}: cam not ready (available=${result.isCamAvailable}, active=${result.isCamActive})`);
            return null;
        }

        return result.streamName;
    }

    public async checkStatusBulk(roomIds: string[]): Promise<Map<string, { status: string; isOnline: boolean }>> {
        const result = new Map<string, { status: string; isOnline: boolean }>();

        for (let i = 0; i < roomIds.length; i += BULK_BATCH_SIZE) {
            const batch = roomIds.slice(i, i + BULK_BATCH_SIZE);
            const params = batch.map((id) => `modelIds[]=${id}`).join("&");
            const url = `https://stripchat.com/api/front/models/list?${params}`;

            const data = await this.fetchJson<any>(url);
            if (!data?.models) continue;

            for (const model of data.models) {
                result.set(String(model.id), {
                    status: model.status ?? "unknown",
                    isOnline: model.isOnline ?? false,
                });
            }
        }

        return result;
    }

    public buildMasterUrl(streamName: string): string {
        const tld = CDN_TLDS[Math.floor(Math.random() * CDN_TLDS.length)];
        return `https://edge-hls.doppiocdn.${tld}/hls/${streamName}/master/${streamName}_auto.m3u8`;
    }

    private selectBestVariantUrl(content: string, masterUrl: string): string | null {
        const { pkey } = getMouflonUrlParams(content);
        if (!pkey) return null;

        const lines = content.split("\n");
        let bestNamed: { url: string; bandwidth: number } | null = null;
        let bestAuto: { url: string; bandwidth: number } | null = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line.startsWith("#EXT-X-STREAM-INF")) continue;

            const nextLine = lines[i + 1]?.trim();
            if (!nextLine || nextLine.startsWith("#")) continue;

            const bwMatch = line.match(/BANDWIDTH=(\d+)/);
            const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;
            const hasResolution = line.includes("RESOLUTION=");

            if (hasResolution) {
                if (!bestNamed || bandwidth > bestNamed.bandwidth) {
                    bestNamed = { url: nextLine, bandwidth };
                }
            } else {
                if (!bestAuto || bandwidth > bestAuto.bandwidth) {
                    bestAuto = { url: nextLine, bandwidth };
                }
            }
        }

        const best = bestNamed ?? bestAuto;
        if (!best) return null;

        const variantUrl = new URL(best.url, masterUrl).href;
        const separator = variantUrl.includes("?") ? "&" : "?";
        return `${variantUrl}${separator}psch=v2&pkey=${pkey}`;
    }

    public async parseMasterPlaylist(masterUrl: string): Promise<string | null> {
        const result = await this.fetchText(masterUrl);
        this.accumulateCookies(result.cookies);

        if (!result.ok) {
            logger.warn(`[SC] Master playlist fetch failed: status=${result.status} url=${masterUrl} body=${result.text.slice(0, 500)}`);
            this.resetSession();
            return null;
        }

        const bestUrl = this.selectBestVariantUrl(result.text, masterUrl);
        if (!bestUrl) {
            logger.warn(`[SC] No variants/mouflon key in master playlist: url=${masterUrl} body=${result.text.slice(0, 500)}`);
            this.resetSession();
            return null;
        }

        return bestUrl;
    }

    public async pollCurrentVariant(masterUrl: string, currentLiveUrl: string): Promise<string | null> {
        const result = await this.fetchText(masterUrl);
        if (!result.ok) return null;
        const bestUrl = this.selectBestVariantUrl(result.text, masterUrl);
        if (!bestUrl) return null;
        const currentBase = currentLiveUrl.split("?")[0];
        const newBase = bestUrl.split("?")[0];
        if (newBase === currentBase) return null;
        return bestUrl;
    }

    public async getMasterList(url: string): Promise<string | null> {
        const result = await this.fetchText(url);
        this.accumulateCookies(result.cookies);
        if (!result.ok) return null;
        return result.text;
    }

    public createDownloadSession(): IDownloadSession {
        return new ScDownloadSession();
    }

    public getSegmentUrl(baseUrl: string, segmentLine: string): string {
        try {
            return new URL(segmentLine, baseUrl).href;
        } catch {
            return segmentLine;
        }
    }

    public async setupDownloadDir(alias: string, date: Date): Promise<string | null> {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        const hours = String(date.getHours()).padStart(2, "0");
        const minutes = String(date.getMinutes()).padStart(2, "0");
        const seconds = String(date.getSeconds()).padStart(2, "0");
        const baseName = `${year}-${month}-${day} ${hours}${minutes}${seconds} ${alias}`;

        const storageLocation = path.join(config.getConfig().storagePath, "sc", "downloader");
        const storageLocationExists = await FileSystemManager.ensureDirExists(storageLocation);
        if (!storageLocationExists) {
            logger.error(`[SC] Could not create or access storage folder at: ${storageLocation}`);
            return null;
        }

        const segmentsDirPath = path.resolve(storageLocation, baseName);
        const segmentsDirExists = await FileSystemManager.ensureDirExists(segmentsDirPath);
        return segmentsDirExists ? segmentsDirPath : null;
    }

    public async validateSegment(filePath: string): Promise<{ valid: boolean; duration?: number }> {
        try {
            const data = await fs.readFile(filePath);
            const duration = parseFmp4Duration(data);
            return { valid: true, duration: duration > 0 ? duration : undefined };
        } catch {
            return { valid: true };
        }
    }
}

class ScDownloadSession implements IDownloadSession {
    private cookies: string[] = [];
    private failLog = new Map<string, number>();

    private getHeaders(): Record<string, string> {
        const headers: Record<string, string> = { "User-Agent": USER_AGENT };
        if (this.cookies.length > 0) {
            headers["Cookie"] = this.cookies.join("; ");
        }
        return headers;
    }

    private accumulateCookies(newCookies: string[]): void {
        const map = new Map<string, string>();
        for (const c of this.cookies) {
            const name = c.split("=")[0];
            map.set(name, c);
        }
        for (const c of newCookies) {
            const name = c.split("=")[0];
            map.set(name, c);
        }
        this.cookies = Array.from(map.values());
    }

    public async getLiveList(liveUrl: string): Promise<{ success: boolean; data: string | null }> {
        try {
            const response = await fetch(liveUrl, { headers: this.getHeaders() });
            const setCookies: string[] = [];
            const raw = response.headers.getSetCookie?.() ?? [];
            for (const c of raw) {
                const name = c.split(";")[0];
                if (name) setCookies.push(name);
            }
            this.accumulateCookies(setCookies);

            if (!response.ok) {
                const count = (this.failLog.get(liveUrl) ?? 0) + 1;
                this.failLog.set(liveUrl, count);
                if (count === 1 || count % 30 === 0) {
                    logger.warn(`[SC] Live playlist fetch failed (x${count}): status=${response.status} url=${liveUrl}`);
                }
                return { success: false, data: null };
            }

            this.failLog.delete(liveUrl);
            const text = await response.text();
            const decrypted = decryptM3u8(text);
            return { success: true, data: decrypted };
        } catch (error: any) {
            logger.error(`[SC] Live playlist fetch error: ${liveUrl}`, { error: error.message });
            return { success: false, data: null };
        }
    }

    public async getTsSegment(tsUrl: string): Promise<Buffer | null> {
        try {
            const response = await fetch(tsUrl, { headers: this.getHeaders() });
            if (response.ok) {
                const buf = await response.arrayBuffer();
                return Buffer.from(buf);
            }
            logger.warn(`[SC] Segment download failed: ${response.status}`, { tsUrl });
        } catch (error: any) {
            if (error?.message !== "terminated") {
                logger.warn(`[SC] Network error downloading segment: ${error.message}`, { tsUrl });
            }
        }
        return null;
    }
}
