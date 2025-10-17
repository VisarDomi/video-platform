// src/api/video.routes.ts
import { Router } from "express";
import * as videoService from "../services/video.service.js";
import * as editService from "../services/edit.service.js";
import * as cacheService from "../services/cache.service.js";
import logger from "../logger.js";

const router = Router();

router.get("/videos", async (_req, res) => {
    const allVideos = videoService.getAllVideos();
    res.json(allVideos);
    cacheService.requestThrottledCacheUpdate();
});

router.post("/edit", async (req, res) => {
    const { filename, segments }: { filename: string; segments: string[] } = req.body;

    if (!filename || !segments || segments.length === 0) {
        return res.status(400).send("Invalid request: filename and segments are required.");
    }

    const editPromise = editService.editVideo(filename, segments);
    res.status(200);
    try {
        await editPromise;
    } catch (error: any) {
        logger.error(`Error editing:`, { message: error.message });
    }
});

router.post("/videos/:filename/:destination", async (req, res) => {
    const { filename, destination } = req.params as { filename: string; destination: "trash" | "original" | "convert" };
    if (!filename || !(destination === "trash" || destination === "original" || destination === "convert")) {
        return res.status(400).send("Invalid request: filename and destination are required. destination can only have the values trash, original, convert");
    }
    const movePromise = videoService.moveVideo(filename, destination);
    res.status(200);
    try {
        await movePromise;
    } catch (error: any) {
        logger.error(`Error moving:`, { message: error.message });
    }
});

export default router;
