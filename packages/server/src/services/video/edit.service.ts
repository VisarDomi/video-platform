import { promises as fsPromises } from "fs";
import path from "path";
import { getProviderPaths } from "../../core/config.js";
import logger from "../../core/logger.js";
import * as utils from "../../core/utils.js";
import * as errors from "../../core/errors.js";
import { DESTINATIONS, FILE_EXTENSIONS } from "../../core/constants.js";
import * as moveService from "./move.service.js";
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

        const destinationPath = path.join(paths.edited, filename);
        await fsPromises.mkdir(destinationPath, { recursive: true });

        const movePromises = validSegments.map((file) =>
            fsPromises.rename(path.join(videoPath, file), path.join(destinationPath, file))
        );
        await Promise.all(movePromises);

        logger.info(`Edited ${filename} with ${validSegments.length} segments at ${destinationPath}`);

        await moveService.moveVideo(filename, DESTINATIONS.TRASH, provider, videoPath);
        logger.info(`Successfully processed and removed original folder: ${filename}`);
    }
}