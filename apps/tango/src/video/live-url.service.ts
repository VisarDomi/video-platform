import { CONSTANTS } from "../core/constants";
import { Emitter } from "../core/emitter";
import { Events } from "../core/events";
import { EventPayloads, Streamer } from "../types";
import { ILiveUrlCache } from "./live-url-cache";

export class LiveUrlService {
    private defaultInit: RequestInit;
    private cache: ILiveUrlCache;
    private emitter: Emitter<EventPayloads>;

    constructor(defaultInit: RequestInit, cache: ILiveUrlCache, emitter: Emitter<EventPayloads>) {
        this.defaultInit = defaultInit;
        this.cache = cache;
        this.emitter = emitter;
    }

    public async fetchAndParseLiveUrl(streamer: Streamer, displayName: string): Promise<string | undefined> {
        const cachedUrl = this.cache.get(streamer.streamerId);
        if (cachedUrl) {
            return cachedUrl;
        }

        try {
            const liveResponse = await fetch(streamer.masterListUrl, this.defaultInit);
            if (liveResponse.ok) {
                const live = await liveResponse.text();
                const liveUrl = this._parseLiveUrlFromPlaylist(streamer.masterListUrl, live);
                if (liveUrl) {
                    this.emitter.emit(Events.DEBUG.LOG, {
                        message: `${displayName} -> Master: OK`,
                        type: 'success'
                    });
                    this.cache.set(streamer.streamerId, liveUrl);
                    return liveUrl;
                }
            }
            this.emitter.emit(Events.DEBUG.LOG, {
                message: `${displayName} -> Master: EMPTY`,
                type: 'error'
            });
        } catch (e: any) {
            this.emitter.emit(Events.DEBUG.LOG, {
                message: `${displayName} -> Master: FAIL (${e?.message})`,
                type: 'error'
            });
            console.error(`Failed to fetch and parse live URL for ${streamer.streamerId}: ${e?.message}`);
        }
        return undefined;
    }

    private _parseLiveUrlFromPlaylist(masterListUrl: string, playlistText: string): string | undefined {
        const HD_RESOLUTION_STRING = CONSTANTS.VIDEO.TARGET_RESOLUTION;
        const BASE_URL = masterListUrl.split("/v2/")[0];
        const lines = playlistText.split("\n");
        let relativeLiveUrl;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(HD_RESOLUTION_STRING)) {
                relativeLiveUrl = lines[i + 1];
                break;
            }
        }
        if (relativeLiveUrl) {
            let liveUrl = `${BASE_URL}${relativeLiveUrl}`;
            if (liveUrl.endsWith("&")) liveUrl = liveUrl.slice(0, -1);
            return liveUrl;
        }
        return undefined;
    }
}
