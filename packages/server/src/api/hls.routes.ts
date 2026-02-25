import { Router, Request } from "express";
import { promises as fs } from "fs";
import path from "path";
import logger from "../core/logger.js";
import * as utils from "../core/utils.js";
import * as fsUtils from "../core/fs-utils.js";
import { API, FILE_EXTENSIONS, FILE_NAMES, MISC } from "../core/constants.js";

const router = Router();

router.get("/hls/:filename/playlist.m3u8", async (req, res) => {
    const { filename } = req.params as { filename: string };
    if (!filename) {
        return res.status(400).json({ success: false, message: API.MESSAGES.INVALID_REQUEST_FILENAME_REQUIRED });
    }

    try {
        const videoPath = await utils.findVideoPath(filename);

        // Ensure playlist exists on disk, generate if missing
        await fsUtils.ensurePlaylist(videoPath);

        const playlistPath = path.join(videoPath, FILE_NAMES.HLS_PLAYLIST);
        const content = await fs.readFile(playlistPath, MISC.ENCODING_UTF8);

        res.setHeader(API.HEADERS.CONTENT_TYPE, API.HEADERS.HLS_CONTENT_TYPE);
        res.send(content);
    } catch (error: any) {
        if (error.name === "FileNotFoundError") {
            return res.status(404).send(API.MESSAGES.VIDEO_NOT_FOUND);
        }
        logger.error(`Error serving playlist for ${filename}`, { error });
        res.status(500).send("Error serving playlist");
    }
});

router.get("/hls/:filename/:segmentName", async (req: Request, res) => {
    const { filename, segmentName } = req.params as { filename: string; segmentName: string };

    if (!filename || !segmentName.endsWith(FILE_EXTENSIONS.TS)) {
        return res.status(400).send(API.MESSAGES.INVALID_REQUEST_SEGMENT_NAME);
    }

    try {
        // Note: findVideoPath does 3 fs checks. This is the cost of "no cache".
        // If this becomes slow, we can optimize later, but for one user it's fine.
        const videoPath = await utils.findVideoPath(filename);
        const segmentPath = path.join(videoPath, segmentName);

        // We use createReadStream for better memory usage with video files
        // Express 'res.sendFile' is also an option but we'll stream manually to catch errors easily
        const data = await fs.readFile(segmentPath);
        res.setHeader(API.HEADERS.CONTENT_TYPE, API.HEADERS.TS_CONTENT_TYPE);
        res.send(data);

    } catch (err: any) {
        if (err.name === "FileNotFoundError" || err.code === MISC.ERROR_CODE.ENOENT) {
            if (!res.headersSent) res.status(404).send(API.MESSAGES.SEGMENT_NOT_FOUND);
        } else {
            logger.error(`Error serving segment ${segmentName}`, { error: err });
            if (!res.headersSent) res.status(500).send(API.MESSAGES.COULD_NOT_SERVE_SEGMENT);
        }
    }
});

export default router;