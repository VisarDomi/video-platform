import { Router } from "express";
import fs from "fs";
import path from "path";
import os from "os";
import * as retrieveService from "../services/video/retrieve.service.js";
import * as moveService from "../services/video/move.service.js";
import * as editService from "../services/video/edit.service.js";
import * as mp4EditService from "../services/video/mp4-edit.service.js";
import * as utils from "../core/utils.js";
import logger from "../core/logger.js";
import { DESTINATIONS, API } from "../core/constants.js";
import * as types from "../core/types.js";

const router = Router();

router.get("/cert", (_req, res) => {
    try {
        const certPath = path.join(os.homedir(), ".local/share/mkcert", "rootCA.pem");
        const certFile = fs.readFileSync(certPath);
        res.set({
            "Content-Disposition": 'attachment; filename="rootCA.pem"',
            "Content-Type": "application/x-x509-ca-cert",
        });
        res.send(certFile);
    } catch (error: any) {
        logger.error("Failed to read rootCA.pem", { message: error.message });
        res.status(500).json({ error: "Certificate not found on server" });
    }
});

router.get("/videos", async (req, res) => {
    try {
        const provider = (req.query.provider as string) || "tango";
        const after = req.query.after as string | undefined;
        const videos = await retrieveService.getAllVideos(provider, after);
        res.json(videos);
    } catch (error: any) {
        logger.error("Failed to retrieve videos", { error });
        res.status(500).json({ error: "Failed to retrieve videos" });
    }
});

router.post("/edit", async (req, res) => {
    const { filename, segments, provider }: { filename: string; segments: string[], provider?: string } = req.body;
    const targetProvider = provider || "tango";

    if (!filename || !segments || segments.length === 0) {
        logger.warn(`[api/edit] rejected: filename=${filename ?? "missing"} segments=${segments?.length ?? "missing"} provider=${targetProvider}`);
        return res.status(400).send(API.MESSAGES.INVALID_REQUEST_FILENAME_SEGMENTS_REQUIRED);
    }

    logger.info(`[api/edit] request: filename=${filename} segments=${segments.length} provider=${targetProvider}`);

    try {
        if (targetProvider === "mp4") {
            const timeSegments = segments.map((s: string) => {
                const [start, end] = s.split(":").map(Number);
                return { start, end };
            });
            mp4EditService.editMp4Video(filename, timeSegments, targetProvider);
            res.json({ success: true });
            return;
        }

        const ref = await utils.resolveVideo(filename, targetProvider);
        await editService.editVideo(ref, segments);
        res.json({ success: true });
    } catch (error: any) {
        if (error.name === "FileNotFoundError") {
            return res.status(404).json({ success: false, error: error.message });
        }
        logger.error(`[api/edit] failed: filename=${filename} provider=${targetProvider}`, { message: error.message });
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post("/videos/:filename/:destination", async (req, res) => {
    const { filename, destination } = req.params as { filename: string; destination: types.Destination };
    const provider = (req.query.provider as string) || "tango";

    if (!filename || !(destination === DESTINATIONS.TRASH || destination === DESTINATIONS.ORIGINAL || destination === DESTINATIONS.EDITED)) {
        return res.status(400).send(API.MESSAGES.INVALID_REQUEST_DESTINATION);
    }
    try {
        const ref = await utils.resolveVideo(filename, provider);
        await moveService.moveVideo(ref, destination);
        res.json({ success: true });
    } catch (error: any) {
        if (error.name === "FileNotFoundError") {
            return res.status(404).json({ success: false, error: error.message });
        }
        logger.error(`Error moving:`, { message: error.message });
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;