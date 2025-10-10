// src/api/video.routes.ts
import { Router } from "express";
import * as videoService from "../services/video.service.js";
import logger from "../logger.js";
import { FileNotFoundError } from "../errors.js";

const router = Router();

// ... (GET /videos, GET /videos/durations, DELETE /videos/:type/:filename routes remain the same) ...

router.get("/videos", async (_req, res) => {
    try {
        const allVideos = await videoService.getAllVideos();
        res.json(allVideos);
    } catch (error: any) {
        logger.error(`Error listing video directories:`, { error });
        res.status(500).json({ success: false, message: "Could not list video directories." });
    }
});

router.get("/videos/durations", async (_req, res) => {
    try {
        const durations = await videoService.getAllVideoDurations();
        res.json(durations);
    } catch (error: any) {
        logger.error(`Error getting video durations:`, { error });
        res.status(500).json({ success: false, message: "Could not retrieve video durations." });
    }
});

router.delete("/videos/:type/:filename", async (req, res) => {
    const { type, filename } = req.params as { type: "original" | "edited"; filename: string };
    if (!filename || (type !== "original" && type !== "edited")) {
        return res.status(400).json({ success: false, message: "Invalid request parameters." });
    }
    try {
        await videoService.trashVideo(type, filename);
        res.json({ success: true, message: "Video moved to trash successfully." });
    } catch (err: any) {
        if (err instanceof FileNotFoundError) return res.status(404).json({ success: false, message: err.message });
        res.status(500).json({ success: false, message: "Failed to move video to trash." });
    }
});

router.post("/edit", async (req, res) => {
    const { filename, segments }: { filename: string; segments: { start: number; end: number }[] } = req.body;

    if (!filename || !segments || segments.length === 0) {
        return res.status(400).json({ success: false, message: "Invalid request: filename and segments are required." });
    }

    try {
        await videoService.createEditedVideo(filename, segments);
        res.json({ success: true, message: "Video edit job completed." });
    } catch (error: any) {
        logger.error(`Failed to handle video processing for ${filename}:`, { error });
        res.status(500).json({ success: false, message: "Failed to handle video processing." });
    }
});

router.post("/videos/original/:filename/save", async (req, res) => {
    const { filename } = req.params;
    try {
        await videoService.moveVideoToEdited("original", filename);
        res.json({ success: true, message: "Video moved to convert folder successfully." });
    } catch (err: any) {
        if (err instanceof FileNotFoundError) return res.status(404).json({ success: false, message: err.message });
        res.status(500).json({ success: false, message: "Failed to move video." });
    }
});

/**
 * WHY THE CHANGE: New route to handle returning an edited video back to the originals folder.
 */
router.post("/videos/edited/:filename/return", async (req, res) => {
    const { filename } = req.params;
    try {
        await videoService.returnVideoToOriginals(filename);
        res.json({ success: true, message: "Video returned to originals successfully." });
    } catch (err: any) {
        if (err instanceof FileNotFoundError) return res.status(404).json({ success: false, message: err.message });
        res.status(500).json({ success: false, message: "Failed to return video." });
    }
});

export default router;
