// src/api/hls.routes.ts
import { Router } from "express";
import path from "path";
import logger from "../logger.js";
import * as hlsService from "../services/hls.service.js";
import * as cacheService from "../services/cache.service.js";

const router = Router();

router.get("/hls/:filename/playlist.m3u8", (req, res) => {
    try {
        const { filename } = req.params as { filename: string };
        const cachedPlaylist = hlsService.getPlaylistFromCache(filename);

        if (cachedPlaylist) {
            if (cachedPlaylist.isLive) {
                res.setHeader("Cache-Control", "max-age=0, no-cache, no-store, must-revalidate");
            }
            res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
            res.send(cachedPlaylist.content);
        } else {
            res.status(404).send("Playlist not found. It might still be processing.");
        }
    } catch (error) {
        logger.error("Failed to serve playlist from cache", { error });
        res.status(500).send("Could not serve playlist.");
    }
});

router.get("/hls/:filename/:segmentName", (req, res) => {
    if (!req.params.segmentName.endsWith(".ts")) {
        return res.status(400).send("Invalid segment name");
    }

    try {
        const { filename, segmentName } = req.params as { filename: string; segmentName: string };
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
    } catch (error) {
        logger.error("Failed to initiate segment serving", { error });
        if (!res.headersSent) {
            res.status(500).send("Could not serve segment.");
        }
    }
});

export default router;
