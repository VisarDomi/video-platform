// src/api/video.routes.ts
import { Router } from "express";
import * as videoService from "../services/video.service.js";
import logger from "../logger.js";
import { FileNotFoundError } from "../errors.js";

const router = Router();

/**
 * GET /api/videos
 * Retrieves a list of all original and edited videos.
 */
router.get("/videos", async (_req, res) => {
    // <-- FIX: Renamed unused 'req' to '_req'
    // logger.info("DEBUG: Received request for GET /api/videos"); // DEBUG: Log request entry
    try {
        const allFiles = await videoService.getAllVideos();
        // logger.info(`DEBUG: Sending ${allFiles.length} video items to client.`); // DEBUG: Log success and count
        res.json(allFiles);
    } catch (error: any) {
        logger.error(`Error listing video directories:`, { error });
        res.status(500).json({ success: false, message: "Could not list video directories." });
    }
});

/**
 * GET /api/videos/durations
 * Retrieves a map of filenames to their duration in seconds.
 */
router.get("/videos/durations", async (_req, res) => {
    // <-- FIX: Renamed unused 'req' to '_req'
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
 * Moves a specified video file to a 'trash' directory.
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
 * Adds a video editing job to the background queue.
 */
router.post("/edit", (req, res) => {
    const { filename, segments }: { filename: string; segments: { start: number; end: number }[] } = req.body;

    if (!filename || !segments || segments.length === 0) {
        return res.status(400).json({ success: false, message: "Invalid request: filename and segments are required." });
    }

    try {
        // This is now a fire-and-forget call that adds the job to the queue
        videoService.createEditedVideo(filename, segments);
        res.json({ success: true, message: "Video edit job has been added to the queue." });
    } catch (error: any) {
        logger.error(`Failed to queue video for processing ${filename}:`, { error });
        res.status(500).json({ success: false, message: "Failed to queue video for processing." });
    }
});

/**
 * POST /api/videos/original/:filename/save
 * Moves an original video to the 'edited' folder without trimming.
 */
router.post("/videos/original/:filename/save", async (req, res) => {
    const { filename } = req.params;

    try {
        await videoService.moveVideoToEdited("original", filename);
        res.json({ success: true, message: "Video moved to edited folder successfully." });
    } catch (err: any) {
        logger.error("Error in moveVideoToEdited route:", { file: filename, err });
        if (err instanceof FileNotFoundError) {
            return res.status(404).json({ success: false, message: err.message });
        }
        res.status(500).json({ success: false, message: "Failed to move video." });
    }
});

export default router;
