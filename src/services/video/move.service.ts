import { promises as fsPromises } from "fs";
import path from "path";
import { VIDEO_DOWNLOAD_PATH, VIDEO_CONVERT_PATH, VIDEO_TRASH_PATH } from "../../config.js";
import logger from "../../logger.js";
import * as utils from "../../utils.js";
import * as errors from "../../errors.js";
import * as databaseService from "../cache/disk/database.service.js";
import * as cacheService from "../cache/memory/cache.service.js";

export async function moveVideo(filename: string, destination: "trash" | "original" | "convert", sourcePath?: string): Promise<void> {
    let newPath: string;
    if (destination === "trash") {
        newPath = VIDEO_TRASH_PATH;
    } else if (destination === "original") {
        newPath = VIDEO_DOWNLOAD_PATH;
    } else if (destination === "convert") {
        newPath = VIDEO_CONVERT_PATH;
    } else {
        throw new errors.MoveError("Destination can only be trash, original, or convert.");
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
        await databaseService.removeFixedPlaylistEntry(filename);
        logger.info(`Moved folder from ${videoPath} to: ${destinationPath} and removed from fixed playlist cache.`);
        await cacheService.triggerCacheUpdate();
    } else {
        throw new errors.MoveError("File is already at the destination.");
    }
}
