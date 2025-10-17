import { Router, Request } from "express";
import { promises as fs } from "fs";
import path from "path";
import logger from "../core/logger.js";
import * as hlsService from "../services/cache/memory/hls.service.js";
import * as cacheService from "../services/cache/memory/cache.service.js";
import * as profilingService from "../services/profiling.service.js";
import { API, FILE_EXTENSIONS, MISC } from "../core/constants.js";

const router = Router();

router.get("/hls/:filename/playlist.m3u8", (req, res) => {
    profilingService.lap(req.id, "route_handler_start");
    const { filename } = req.params as { filename: string };
    if (!filename) {
        return res.status(400).json({ success: false, message: API.MESSAGES.INVALID_REQUEST_FILENAME_REQUIRED });
    }
    const cachedPlaylist = hlsService.getPlaylistFromCache(filename);
    profilingService.lap(req.id, "cache_lookup_end");
    if (cachedPlaylist) {
        if (cachedPlaylist.isLive) {
            res.setHeader(API.HEADERS.CACHE_CONTROL, API.HEADERS.NO_CACHE);
        }
        res.setHeader(API.HEADERS.CONTENT_TYPE, API.HEADERS.HLS_CONTENT_TYPE);
        res.send(cachedPlaylist.content);
    } else {
        // Handle case where playlist is not in cache, though this is less likely for active videos.
        res.status(404).send("Playlist not found.");
    }
});

router.get("/hls/:filename/:segmentName", async (req: Request, res) => {
    profilingService.lap(req.id, "route_handler_start");
    const { filename, segmentName } = req.params as { filename: string; segmentName: string };
    if (!filename || !segmentName.endsWith(FILE_EXTENSIONS.TS)) {
        return res.status(400).send(API.MESSAGES.INVALID_REQUEST_SEGMENT_NAME);
    }

    const folderPath = cacheService.getVideoPathFromCache(filename);
    profilingService.lap(req.id, "cache_lookup_end");

    if (!folderPath) {
        logger.warn(`Video path not found in cache for filename: ${filename}`);
        return res.status(404).send(API.MESSAGES.VIDEO_NOT_FOUND);
    }

    const segmentPath = path.join(folderPath, segmentName);

    try {
        profilingService.lap(req.id, "file_read_start");
        const data = await fs.readFile(segmentPath);
        profilingService.lap(req.id, "file_read_end");
        res.setHeader(API.HEADERS.CONTENT_TYPE, API.HEADERS.TS_CONTENT_TYPE);
        res.send(data);
    } catch (err: any) {
        if (err.code === MISC.ERROR_CODE.ENOENT) {
            logger.warn(`Segment not found on disk: ${segmentPath}`);
            if (!res.headersSent) res.status(404).send(API.MESSAGES.SEGMENT_NOT_FOUND);
        } else {
            logger.error(`Error sending segment file: ${segmentPath}`, { error: err });
            if (!res.headersSent) res.status(500).send(API.MESSAGES.COULD_NOT_SERVE_SEGMENT);
        }
    }
});

export default router;
