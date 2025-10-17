import { promises as fsPromises } from "fs";
import path from "path";
import { VIDEO_DOWNLOADER_PATH, VIDEO_EDITED_PATH, VIDEO_TRASH_PATH } from "../../core/config.js";
import logger from "../../core/logger.js";
import * as utils from "../../core/utils.js";
import { DESTINATIONS, LOGS } from "../../core/constants.js";
import * as types from "../../core/types.js";
import * as errors from "../../core/errors.js";
import * as databaseService from "../cache/disk/database.service.js";
import * as cacheService from "../cache/memory/cache.service.js";

export async function moveVideo(filename: string, destination: types.Destination, sourcePath?: string): Promise<void> {
    let newPath: string;
    if (destination === DESTINATIONS.TRASH) {
        newPath = VIDEO_TRASH_PATH;
    } else if (destination === DESTINATIONS.ORIGINAL) {
        newPath = VIDEO_DOWNLOADER_PATH;
    } else if (destination === DESTINATIONS.EDITED) {
        newPath = VIDEO_EDITED_PATH;
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
        await databaseService.removeDurationsEntry(filename);
        await databaseService.removeFixedPlaylistEntry(filename);
        logger.info(`Moved folder from ${videoPath} to: ${destinationPath} and removed from fixed playlist cache.`);
        await cacheService.triggerCacheUpdate();
    } else {
        throw new errors.MoveError(LOGS.MESSAGES.MOVE_ERROR);
    }
}
