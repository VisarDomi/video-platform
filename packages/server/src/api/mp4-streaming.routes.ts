import { Router } from "express";
import { promises as fsPromises } from "fs";
import * as fs from "fs";
import path from "path";
import { getProviderPaths } from "../core/config.js";
import logger from "../core/logger.js";
import { ALL_VIDEO_PATHS_TYPES } from "../core/constants.js";

const router = Router();

async function findMp4File(type: string, filename: string): Promise<string | null> {
    const paths = getProviderPaths("mp4");
    let searchDirs: string[];

    if (type === ALL_VIDEO_PATHS_TYPES.ORIGINAL) {
        searchDirs = [paths.downloader];
    } else {
        searchDirs = [paths.edited, paths.converted];
    }

    for (const dir of searchDirs) {
        const fullPath = path.join(dir, filename);
        try {
            await fsPromises.access(fullPath);
            return fullPath;
        } catch {}
    }

    return null;
}

router.get("/mp4/:type/:filename", async (req, res) => {
    const { type, filename } = req.params;

    if (type !== ALL_VIDEO_PATHS_TYPES.ORIGINAL && type !== ALL_VIDEO_PATHS_TYPES.EDITED) {
        return res.status(400).send("Invalid video type specified.");
    }

    const safeFilename = path.normalize(filename).replace(/^(\.\.[\/\\])+/, "");
    const videoFilePath = await findMp4File(type, safeFilename);

    if (!videoFilePath) {
        logger.warn(`MP4 file not found: { type: ${type}, filename: ${safeFilename} }`);
        return res.status(404).send("Video file not found.");
    }

    try {
        const stat = await fsPromises.stat(videoFilePath);
        const fileSize = stat.size;
        const range = req.headers.range;
        const contentType = "video/mp4";

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

            if (start >= fileSize) {
                res.status(416).send(`Requested range not satisfiable\n${start} >= ${fileSize}`);
                return;
            }

            const chunksize = end - start + 1;
            const file = fs.createReadStream(videoFilePath, { start, end });
            const head = {
                "Content-Range": `bytes ${start}-${end}/${fileSize}`,
                "Accept-Ranges": "bytes",
                "Content-Length": chunksize,
                "Content-Type": contentType,
            };
            res.writeHead(206, head);
            file.pipe(res);
        } else {
            const head = { "Content-Length": fileSize, "Content-Type": contentType };
            res.writeHead(200, head);
            fs.createReadStream(videoFilePath).pipe(res);
        }
    } catch (error) {
        logger.error(`Failed to stream MP4 file at path: ${videoFilePath}`, { error });
        if (!res.headersSent) {
            res.status(500).send("Could not stream video file.");
        }
    }
});

export default router;
