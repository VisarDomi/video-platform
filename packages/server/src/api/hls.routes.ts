import { Router, Request } from "express";
import { promises as fs } from "fs";
import path from "path";
import logger from "../core/logger.js";
import * as utils from "../core/utils.js";
import { API, FILE_EXTENSIONS, FILE_NAMES, MISC } from "../core/constants.js";

const router = Router();

router.get("/hls/:provider/:filename/playlist.m3u8", async (req, res) => {
    const { filename, provider } = req.params as { filename: string; provider: string };
    if (!filename) {
        return res.status(400).json({ success: false, message: API.MESSAGES.INVALID_REQUEST_FILENAME_REQUIRED });
    }

    try {
        const ref = await utils.resolveVideo(filename, provider);
        const playlistPath = path.join(ref.dirPath, FILE_NAMES.HLS_PLAYLIST);
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

router.get("/hls/:provider/:filename/:segmentName", async (req: Request, res) => {
    const { filename, provider, segmentName } = req.params as { filename: string; provider: string; segmentName: string };

    const isTs = segmentName.endsWith(FILE_EXTENSIONS.TS);
    const isMp4 = segmentName.endsWith(FILE_EXTENSIONS.MP4);

    if (!filename || (!isTs && !isMp4)) {
        return res.status(400).send(API.MESSAGES.INVALID_REQUEST_SEGMENT_NAME);
    }

    try {
        const ref = await utils.resolveVideo(filename, provider);
        const segmentPath = path.join(ref.dirPath, segmentName);

        const data = await fs.readFile(segmentPath);
        const contentType = isMp4 ? API.HEADERS.MP4_CONTENT_TYPE : API.HEADERS.TS_CONTENT_TYPE;
        res.setHeader(API.HEADERS.CONTENT_TYPE, contentType);
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