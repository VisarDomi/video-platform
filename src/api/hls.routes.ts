// src/api/hls.routes.ts
import { Router } from "express";
import path from "path";
import logger from "../logger.js";
import * as hlsService from "../services/hls.service.js";
import * as videoService from "../services/video.service.js";

const router = Router();

router.get("/hls/:filename/playlist.m3u8", (req, res) => {
    const { filename } = req.params as { filename: string };
    const cachedPlaylist = hlsService.getPlaylistFromCache(filename);

    if (cachedPlaylist) {
        if (cachedPlaylist.isLive) {
            res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
            res.setHeader("Pragma", "no-cache");
            res.setHeader("Expires", "0");
        }
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.send(cachedPlaylist.content);
    } else {
        logger.warn(`Playlist for ${filename} not found in cache.`);
        res.status(404).send("Playlist not found in cache.");
    }
});

router.get("/hls/:filename/:segmentName", (req, res) => {
    if (!req.params.segmentName.endsWith(".ts")) {
        return res.status(400).send("Invalid segment name");
    }

    const { filename, segmentName } = req.params as { filename: string; segmentName: string };
    const folderPath = videoService.getKnownVideoPath(filename);

    if (folderPath) {
        const segmentPath = path.join(folderPath, segmentName);
        res.setHeader("Content-Type", "video/mp2t");
        res.sendFile(segmentPath, (err) => {
            if (err && !res.headersSent) {
                logger.warn(`Error sending segment file ${segmentPath}`, { error: err.message });
                res.status(404).send("Segment not found.");
            }
        });
    } else {
        logger.warn(`Video folder path for ${filename} not found in cache.`);
        res.status(404).send("Video not found.");
    }
});

export default router;
