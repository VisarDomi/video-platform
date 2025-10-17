import { Router } from "express";
import * as retrieveService from "../services/video/retrieve.service.js";
import * as moveService from "../services/video/move.service.js";
import * as editService from "../services/video/edit.service.js";
import * as cacheService from "../services/cache/memory/cache.service.js";
import logger from "../core/logger.js";

const router = Router();

router.get("/videos", async (_req, res) => {
    const allVideos = retrieveService.getAllVideos();
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
    const { filename, destination } = req.params as { filename: string; destination: moveService.Destination };
    if (!filename || !(destination === moveService.TRASH || destination === moveService.ORIGINAL || destination === moveService.EDITED)) {
        return res.status(400).send("Invalid request: filename and destination are required. destination can only have the values trash, original, edited");
    }
    const movePromise = moveService.moveVideo(filename, destination);
    res.status(200);
    try {
        await movePromise;
    } catch (error: any) {
        logger.error(`Error moving:`, { message: error.message });
    }
});

export default router;
