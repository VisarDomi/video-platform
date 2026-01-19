import { Router } from "express";
import * as retrieveService from "../services/video/retrieve.service.js";
import * as moveService from "../services/video/move.service.js";
import * as editService from "../services/video/edit.service.js";
import logger from "../core/logger.js";
import { DESTINATIONS, API } from "../core/constants.js";
import * as types from "../core/types.js";

const router = Router();

router.get("/videos", async (req, res) => {
    try {
        const provider = (req.query.provider as string) || "tango";
        const allVideos = await retrieveService.getAllVideos(provider);
        res.json(allVideos);
    } catch (error: any) {
        logger.error("Failed to retrieve videos", { error });
        res.status(500).json({ error: "Failed to retrieve videos" });
    }
});

router.post("/edit", async (req, res) => {
    const { filename, segments, provider }: { filename: string; segments: string[], provider?: string } = req.body;
    const targetProvider = provider || "tango";

    if (!filename || !segments || segments.length === 0) {
        return res.status(400).send(API.MESSAGES.INVALID_REQUEST_FILENAME_SEGMENTS_REQUIRED);
    }

    const editPromise = editService.editVideo(filename, segments, targetProvider);
    res.status(200);
    try {
        await editPromise;
    } catch (error: any) {
        logger.error(`Error editing:`, { message: error.message });
    }
});

router.post("/videos/:filename/:destination", async (req, res) => {
    const { filename, destination } = req.params as { filename: string; destination: types.Destination };
    const provider = (req.query.provider as string) || "tango";

    if (!filename || !(destination === DESTINATIONS.TRASH || destination === DESTINATIONS.ORIGINAL || destination === DESTINATIONS.EDITED)) {
        return res.status(400).send(API.MESSAGES.INVALID_REQUEST_DESTINATION);
    }
    const movePromise = moveService.moveVideo(filename, destination, provider);
    res.status(200);
    try {
        await movePromise;
    } catch (error: any) {
        logger.error(`Error moving:`, { message: error.message });
    }
});

export default router;