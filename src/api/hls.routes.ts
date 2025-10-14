// src/api/hls.routes.ts
import { Router } from "express";
import path from "path";
import * as fsPromises from "fs/promises";
import logger from "../logger.js";
import * as utils from "../utils.js";
import * as errors from "../errors.js";

const router = Router();

router.get("/hls/:filename/playlist.m3u8", async (req, res) => {
    try {
        const { filename } = req.params as { filename: string };
        const videoPath = await utils.findVideoPath(filename);
        const playlistPath = path.join(videoPath, "playlist.m3u8");
        const playlistContent = await fsPromises.readFile(playlistPath, "utf-8");
        if (!playlistContent.trim().endsWith("#EXT-X-ENDLIST")) {
            res.setHeader("Cache-Control", "max-age=0, no-cache");
            res.setHeader("age", "0");
        }

        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.sendFile(playlistPath);
    } catch (error) {
        if (error instanceof errors.FileNotFoundError) {
            logger.warn(error.message);
            return res.status(404).send(error.message);
        }
        logger.error("Failed to serve playlist", { error });
        res.status(500).send("Could not serve playlist.");
    }
});

router.get("/hls/:filename/:segmentName", async (req, res) => {
    if (!req.params.segmentName.endsWith(".ts")) {
        return res.status(400).send("Invalid segment name");
    }

    try {
        const { filename, segmentName } = req.params as { filename: string; segmentName: string };
        const folderPath = await utils.findVideoPath(filename);
        const segmentPath = path.join(folderPath, segmentName);

        res.setHeader("Content-Type", "video/mp2t");
        res.sendFile(segmentPath);
    } catch (error) {
        if (error instanceof errors.FileNotFoundError) {
            logger.warn(error.message);
            return res.status(404).send(error.message);
        }
        logger.error("Failed to serve segment", { error });
        res.status(500).send("Could not serve segment.");
    }
});

export default router;
