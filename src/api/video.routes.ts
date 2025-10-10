// src/api/video.routes.ts
import { Router } from "express";
import * as videoService from "../services/video.service.js";
import logger from "../logger.js";

const router = Router();

/**
 * GET /api/videos
 * Retrieves a list of all video folders.
 */
router.get("/videos", async (_req, res) => {
    try {
        const allVideos = await videoService.getAllVideos();
        res.json(allVideos);
    } catch (error: any) {
        logger.error(`Error listing video directories:`, { error });
        res.status(500).json({ success: false, message: "Could not list video directories." });
    }
});

/**
 * GET /api/videos/durations
 * Retrieves a map of video folder names to their duration in seconds.
 */
router.get("/videos/durations", async (_req, res) => {
    try {
        const durations = await videoService.getAllVideoDurations();
        res.json(durations);
    } catch (error: any) {
        logger.error(`Error getting video durations:`, { error });
        res.status(500).json({ success: false, message: "Could not retrieve video durations." });
    }
});

export default router;
