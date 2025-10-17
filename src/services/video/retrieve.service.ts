import * as types from "../../types.js";
import * as cacheService from "../cache/memory/cache.service.js";

export function getAllVideos(): types.VideoItem[] {
    return cacheService.getVideosFromCache();
}
