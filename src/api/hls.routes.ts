import { Router } from "express";
import path from "path";
import logger from "../core/logger.js";
import * as hlsService from "../services/cache/memory/hls.service.js";
import * as cacheService from "../services/cache/memory/cache.service.js";
import { API, FILE_EXTENSIONS, MISC } from "../core/constants.js";

const router = Router();

router.get("/hls/:filename/playlist.m3u8", (req, res) => {
    const { filename } = req.params as { filename: string };
    if (!filename) {
        return res.status(400).json({ success: false, message: API.MESSAGES.INVALID_REQUEST_FILENAME_REQUIRED });
    }
    const cachedPlaylist = hlsService.getPlaylistFromCache(filename);
    if (cachedPlaylist) {
        if (cachedPlaylist.isLive) {
            res.setHeader(API.HEADERS.CACHE_CONTROL, API.HEADERS.NO_CACHE);
        }
        res.setHeader(API.HEADERS.CONTENT_TYPE, API.HEADERS.HLS_CONTENT_TYPE);
        res.send(cachedPlaylist.content);
    }
});

router.get("/hls/:filename/:segmentName", (req, res) => {
    const { filename, segmentName } = req.params as { filename: string; segmentName: string };
    if (!filename || !segmentName.endsWith(FILE_EXTENSIONS.TS)) {
        return res.status(400).send(API.MESSAGES.INVALID_REQUEST_SEGMENT_NAME);
    }

    const folderPath = cacheService.getVideoPathFromCache(filename);
    if (!folderPath) {
        logger.warn(`Video path not found in cache for filename: ${filename}`);
        return res.status(404).send(API.MESSAGES.VIDEO_NOT_FOUND);
    }

    const segmentPath = path.join(folderPath, segmentName);

    res.setHeader(API.HEADERS.CONTENT_TYPE, API.HEADERS.TS_CONTENT_TYPE);
    res.sendFile(segmentPath, (err) => {
        if (!err) return;
        if ((err as any).code === MISC.ERROR_CODE.ENOENT) {
            logger.warn(`Segment not found on disk: ${segmentPath}`);
            if (!res.headersSent) res.status(404).send(API.MESSAGES.SEGMENT_NOT_FOUND);
        } else if ((err as any).code === MISC.ERROR_CODE.ECONNABORTED) {
        } else {
            logger.error(`Error sending segment file: ${segmentPath}`, { error: err });
            if (!res.headersSent) res.status(500).send(API.MESSAGES.COULD_NOT_SERVE_SEGMENT);
        }
    });
});

export default router;
