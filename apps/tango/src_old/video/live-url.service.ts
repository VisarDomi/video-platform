import {CONSTANTS} from "../core/constants";
import {Streamer} from "../types";
import {ILiveUrlCache} from "./live-url-cache";

export class LiveUrlService {
    private cache: ILiveUrlCache;

    constructor(cache: ILiveUrlCache) {
        this.cache = cache;
    }

    public async fetchAndParseLiveUrl(streamer: Streamer): Promise<string | undefined> {
        const cachedUrl = this.cache.get(streamer.streamerId);
        if (cachedUrl) {
            return cachedUrl;
        }

        const liveResponse = await fetch(streamer.masterListUrl, { credentials: "include", mode: "cors" });
        if (liveResponse.ok) {
            const live = await liveResponse.text();
            const liveUrl = this._parseLiveUrlFromPlaylist(streamer.masterListUrl, live);
            if (liveUrl) {
                this.cache.set(streamer.streamerId, liveUrl);
                return liveUrl;
            }
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
