// src/api/video.routes.ts
import { Router } from "express";
import * as videoService from "../services/video.service.js";
import logger from "../logger.js";
import { FileNotFoundError } from "../errors.js";

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

/**
 * DELETE /api/videos/:type/:filename
 * Moves a specified video folder to a 'trash' directory.
 */
router.delete("/videos/:type/:filename", async (req, res) => {
    const { type, filename } = req.params as { type: "original" | "edited"; filename: string };

    if (!filename || (type !== "original" && type !== "edited")) {
        return res.status(400).json({ success: false, message: "Invalid request parameters." });
    }

    try {
        await videoService.trashVideo(type, filename);
        res.json({ success: true, message: "Video moved to trash successfully." });
    } catch (err: any) {
        logger.error("Error in trashVideo route:", { file: filename, err });
        if (err instanceof FileNotFoundError) {
            return res.status(404).json({ success: false, message: err.message });
        }
        res.status(500).json({ success: false, message: "Failed to move video to trash." });
    }
});

/**
 * POST /api/edit
 * Handles a video editing request.
 */
router.post("/edit", (req, res) => {
    const { filename, segments }: { filename: string; segments: { start: number; end: number }[] } = req.body;

    if (!filename || !segments || segments.length === 0) {
        return res.status(400).json({ success: false, message: "Invalid request: filename and segments are required." });
    }

    try {
        videoService.createEditedVideo(filename, segments);
        res.json({ success: true, message: "Video edit job received." });
    } catch (error: any) {
        logger.error(`Failed to handle video processing for ${filename}:`, { error });
        res.status(500).json({ success: false, message: "Failed to handle video processing." });
    }
});

/**
 * POST /api/videos/original/:filename/save
 * Moves an original video to the 'modified' folder without trimming.
 */
router.post("/videos/original/:filename/save", async (req, res) => {
    const { filename } = req.params;

    try {
        await videoService.moveVideoToEdited("original", filename);
        res.json({ success: true, message: "Video moved to modified folder successfully." });
    } catch (err: any) {
        logger.error("Error in moveVideoToEdited route:", { file: filename, err });
        if (err instanceof FileNotFoundError) {
            return res.status(404).json({ success: false, message: err.message });
        }
        res.status(500).json({ success: false, message: "Failed to move video." });
    }
});

export default router;
