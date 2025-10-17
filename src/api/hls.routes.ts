// src/api/hls.routes.ts
import { Router } from "express";
import path from "path";
import logger from "../logger.js";
import * as hlsService from "../services/hls.service.js";
import * as cacheService from "../services/cache.service.js";

const router = Router();

router.get("/hls/:filename/playlist.m3u8", (req, res) => {
    const { filename } = req.params as { filename: string };
    if (!filename) {
        return res.status(400).json({ success: false, message: "Invalid request: filename is required." });
    }
    const cachedPlaylist = hlsService.getPlaylistFromCache(filename);
    if (cachedPlaylist) {
        if (cachedPlaylist.isLive) {
            res.setHeader("Cache-Control", "max-age=0, no-cache, no-store, must-revalidate");
        }
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.send(cachedPlaylist.content);
    }
});

router.get("/hls/:filename/:segmentName", (req, res) => {
    const { filename, segmentName } = req.params as { filename: string; segmentName: string };
    if (!filename || !segmentName.endsWith(".ts")) {
        return res.status(400).send("Invalid request: filename is required and segment name should end in .ts");
    }
    const folderPath = cacheService.getVideoPathFromCache(filename);

    if (!folderPath) {
        logger.warn(`Video path not found in cache for filename: ${filename}`);
        return res.status(404).send("Video not found.");
    }

    const segmentPath = path.join(folderPath, segmentName);

    res.setHeader("Content-Type", "video/mp2t");
    res.sendFile(segmentPath, (err) => {
        if (!err) return;
        if ((err as any).code === "ENOENT") {
            logger.warn(`Segment not found on disk: ${segmentPath}`);
            if (!res.headersSent) res.status(404).send("Segment not found.");
        } else {
            logger.error(`Error sending segment file: ${segmentPath}`, { error: err });
            if (!res.headersSent) res.status(500).send("Could not serve segment.");
        }
    });
});

export default router;
