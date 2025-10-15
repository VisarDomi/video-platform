// src/api/video.routes.ts
import { Router } from "express";
import * as videoService from "../services/video.service.js";
import * as editService from "../services/edit.service.js";
import * as metadataService from "../services/metadata.service.js";
import logger from "../logger.js";
import * as errors from "../errors.js";

const router = Router();

router.get("/videos", (_req, res) => {
    try {
        const allVideos = videoService.getAllVideos();
        res.json(allVideos);
    } catch (error: any) {
        logger.error(`Error listing video directories:`, { error });
        res.status(500).json({ success: false, message: "Could not list video directories." });
    }
});

router.post("/edit", async (req, res) => {
    const { filename, segments }: { filename: string; segments: string[] } = req.body;

    if (!filename || !segments || segments.length === 0) {
        return res.status(400).json({ success: false, message: "Invalid request: filename and segments are required." });
    }

    try {
        await editService.createEditedVideo(filename, segments);
        res.json({ success: true, message: "Video edit job completed." });
    } catch (error: any) {
        if (error instanceof errors.SegmentError) return res.status(404).json({ success: false, message: error.message });
        logger.error(`Failed to handle video processing for ${filename}:`, { error });
        res.status(500).json({ success: false, message: "Failed to handle video processing." });
    }
});

router.post("/videos/:filename/:destination", async (req, res) => {
    const { filename, destination } = req.params as { filename: string; destination: "trash" | "original" | "convert" };
    try {
        await videoService.moveVideo(filename, destination);
        res.json({ success: true, message: "Video moved successfully." });
    } catch (err: any) {
        if (err instanceof errors.FileNotFoundError) return res.status(404).json({ success: false, message: err.message });
        if (err instanceof errors.MoveError) return res.status(400).json({ success: false, message: err.message });
        res.status(500).json({ success: false, message: "Failed to move video." });
    }
});

router.get("/videos/details", (_req, res) => {
    try {
        const details = metadataService.getAllCachedDetails();
        res.json(details);
    } catch (error) {
        logger.error("Error getting video details:", { error });
        res.status(500).json({ success: false, message: "Could not get video details." });
    }
});

export default router;
