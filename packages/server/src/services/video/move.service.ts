import { promises as fsPromises } from "fs";
import path from "path";
import { getProviderPaths } from "../../core/config.js";
import logger from "../../core/logger.js";
import { DESTINATIONS, LOGS } from "../../core/constants.js";
import * as types from "../../core/types.js";
import * as errors from "../../core/errors.js";

export async function moveVideo(ref: types.VideoRef, destination: types.Destination): Promise<void> {
    const paths = getProviderPaths(ref.provider);

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

    const videoPath = ref.dirPath;

    if (!videoPath.startsWith(newPath)) {
        await fsPromises.mkdir(newPath, { recursive: true });
        let destinationFilename = ref.filename;
        let destinationPath = path.join(newPath, destinationFilename);
        let counter = 1;

        while (true) {
            try {
                await fsPromises.access(destinationPath);
                destinationFilename = `${ref.filename} (${counter++})`;
                destinationPath = path.join(newPath, destinationFilename);
            } catch (error) {
                break;
            }
        }

        await fsPromises.rename(videoPath, destinationPath);

        logger.info(`Moved folder from ${videoPath} to: ${destinationPath}`);
    } else {
        throw new errors.MoveError(LOGS.MESSAGES.MOVE_ERROR);
    }
}
