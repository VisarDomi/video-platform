// src/api/hls.routes.ts
import { Router } from "express";
import path from "path";
import { promises as fs } from "fs";
// WHY: Import specific paths from config
import { VIDEO_DOWNLOAD_PATH, VIDEO_CONVERT_PATH, VIDEO_MODIFIED_PATH } from "../config.js";
import logger from "../logger.js";
import { FileNotFoundError } from "../errors.js";

const router = Router();

/**
 * Finds the full path to a video folder based on its type.
 */
async function findVideoFolderPath(type: "original" | "edited", folderName: string): Promise<string> {
    if (type === "original") {
        const fullPath = path.join(VIDEO_DOWNLOAD_PATH, folderName);
        try {
            await fs.access(fullPath);
            return fullPath;
        } catch {
            throw new FileNotFoundError(`Original video folder not found: ${folderName}`);
        }
    } else {
        // For 'edited', check 'convert' first, then 'modified'.
        const convertPath = path.join(VIDEO_CONVERT_PATH, folderName);
        try {
            await fs.access(convertPath);
            return convertPath;
        } catch {
            // Not in convert, try modified
            const modifiedPath = path.join(VIDEO_MODIFIED_PATH, folderName);
            try {
                await fs.access(modifiedPath);
                return modifiedPath;
            } catch {
                throw new FileNotFoundError(`Edited video folder not found in convert or modified: ${folderName}`);
            }
        }
    }
}

router.get("/hls/:type/:folderName/playlist.m3u8", async (req, res) => {
    try {
        const { type, folderName } = req.params as { type: "original" | "edited"; folderName: string };
        const folderPath = await findVideoFolderPath(type, folderName);
        const playlistPath = path.join(folderPath, "playlist.m3u8");

        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.sendFile(playlistPath);
    } catch (error) {
        if (error instanceof FileNotFoundError) {
            logger.warn(error.message);
            return res.status(404).send(error.message);
        }
        logger.error("Failed to serve playlist", { error });
        res.status(500).send("Could not serve playlist.");
    }
});

router.get("/hls/:type/:folderName/:segmentName", async (req, res) => {
    if (!req.params.segmentName.endsWith(".ts")) {
        return res.status(400).send("Invalid segment name");
    }

    try {
        const { type, folderName, segmentName } = req.params as { type: "original" | "edited"; folderName: string; segmentName: string };
        const folderPath = await findVideoFolderPath(type, folderName);
        const segmentPath = path.join(folderPath, segmentName);

        res.setHeader("Content-Type", "video/mp2t");
        res.sendFile(segmentPath);
    } catch (error) {
        if (error instanceof FileNotFoundError) {
            return res.status(404).send(error.message);
        }
        logger.error("Failed to serve segment", { error });
        res.status(500).send("Could not serve segment.");
    }
});

export default router;
