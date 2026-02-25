import { promises as fsPromises } from "fs";
import path from "path";
import { getProviderPaths } from "../../core/config.js";
import logger from "../../core/logger.js";
import * as utils from "../../core/utils.js";
import { DESTINATIONS, LOGS } from "../../core/constants.js";
import * as types from "../../core/types.js";
import * as errors from "../../core/errors.js";

export async function moveVideo(filename: string, destination: types.Destination, provider: string, sourcePath?: string): Promise<void> {
    const paths = getProviderPaths(provider);

    let newPath: string;
    if (destination === DESTINATIONS.TRASH) {
        newPath = paths.trash;
    } else if (destination === DESTINATIONS.ORIGINAL) {
        newPath = paths.downloader;
    } else if (destination === DESTINATIONS.EDITED) {
        newPath = paths.edited;
    } else {
        throw new errors.MoveError(LOGS.MESSAGES.DESTINATION_ERROR);
    }

    const videoPath = sourcePath ?? (await utils.findVideoPath(filename));
    if (!videoPath) throw new errors.FileNotFoundError(`Video folder not found: ${filename}`);

    if (!videoPath.startsWith(newPath)) {
        let destinationFilename = filename;
        let destinationPath = path.join(newPath, destinationFilename);
        let counter = 1;

        while (true) {
            try {
                await fsPromises.access(destinationPath);
                destinationFilename = `${filename} (${counter++})`;
                destinationPath = path.join(newPath, destinationFilename);
            } catch (error) {
                break;
            }
        }

        await fsPromises.rename(videoPath, destinationPath);

        // No database or cache cleanup needed anymore.
        // If the video is moved back, the retrieve service will just read it from the new location on next request.

        logger.info(`Moved folder from ${videoPath} to: ${destinationPath}`);
    } else {
        throw new errors.MoveError(LOGS.MESSAGES.MOVE_ERROR);
    }
}