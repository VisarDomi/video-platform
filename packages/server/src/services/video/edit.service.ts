import { promises as fsPromises } from "fs";
import path from "path";
import { getProviderPaths } from "../../core/config.js";
import logger from "../../core/logger.js";
import * as utils from "../../core/utils.js";
import * as errors from "../../core/errors.js";
import { DESTINATIONS, FILE_EXTENSIONS, MISC } from "../../core/constants.js";
import * as moveService from "./move.service.js";
import * as fsUtils from "../../core/fs-utils.js";
import pLimit from "p-limit";

const probeLimit = pLimit(5);

async function getParts(videoPath: string, tsFiles: string[]): Promise<string[][]> {
    const parts: string[][] = [];
    if (tsFiles.length === 0) return parts;

    // Probe all selected segments to get durations
    const durationPromises = tsFiles.map(file =>
        probeLimit(() => fsUtils.getSegmentDuration(path.join(videoPath, file)))
    );
    const durations = await Promise.all(durationPromises);

    let tsChunk: string[] = [];
    let chunkDuration = 0;

    for (let i = 0; i < tsFiles.length; i++) {
        const file = tsFiles[i];
        const duration = durations[i];

        tsChunk.push(file);
        chunkDuration += duration;

        // Split if chunk exceeds max duration (30 mins)
        if (chunkDuration > MISC.MAX_EDIT_CHUNK_DURATION_SECONDS) {
            parts.push([...tsChunk]);
            tsChunk = [];
            chunkDuration = 0;
        }
    }

    if (tsChunk.length > 0) {
        parts.push([...tsChunk]);
    }

    return parts;
}

export async function editVideo(filename: string, segments: string[], provider: string): Promise<void> {
    const paths = getProviderPaths(provider);
    const videoPath = await utils.findVideoPath(filename);
    if (!videoPath) throw new errors.FileNotFoundError(`Video folder not found: ${filename}`);

    const allSourceTsFiles = (await fsPromises.readdir(videoPath)).filter((f) => f.endsWith(FILE_EXTENSIONS.TS));
    const segmentSet = new Set(segments);

    // Filter to ensure we only process segments that actually exist on disk
    const validSegments = allSourceTsFiles.filter(f => segmentSet.has(f));

    // Sort them numerically to ensure correct order
    validSegments.sort((a, b) => {
        return parseInt(a, 10) - parseInt(b, 10);
    });

    if (validSegments.length > 0) {
        logger.info(`Editing ${filename} [${provider}]: processing ${validSegments.length} segments...`);

        const parts = await getParts(videoPath, validSegments);

        for (let i = 0; i < parts.length; i++) {
            const tsChunk = parts[i];
            const partFolderName = parts.length > 1 ? `${filename}${MISC.EDITED_VIDEO_PART_SUFFIX(i + 1)}` : filename;
            const destinationPath = path.join(paths.edited, partFolderName);

            await fsPromises.mkdir(destinationPath, { recursive: true });

            const movePromises = tsChunk.map((file) =>
                fsPromises.rename(path.join(videoPath, file), path.join(destinationPath, file))
            );
            await Promise.all(movePromises);

            // Note: We do NOT generate the playlist here.
            // It will be generated automatically by the HLS route when the user opens the video.

            logger.info(`Created part ${i + 1} for ${filename} with ${tsChunk.length} segments at ${destinationPath}`);
        }

        await moveService.moveVideo(filename, DESTINATIONS.TRASH, provider, videoPath);
        logger.info(`Successfully processed and removed original folder: ${filename}`);
    }
}