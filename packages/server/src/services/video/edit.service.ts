import { promises as fsPromises } from "fs";
import path from "path";
import { getProviderPaths } from "../../core/config.js";
import logger from "../../core/logger.js";
import * as utils from "../../core/utils.js";
import * as errors from "../../core/errors.js";
import { DESTINATIONS, FILE_EXTENSIONS, FILE_NAMES } from "../../core/constants.js";
import * as moveService from "./move.service.js";

function deriveEditedPlaylist(content: string, keepSet: Set<string>): string {
    const lines = content.split("\n");
    const result: string[] = [];
    const metadataBuffer: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed === "#EXT-X-ENDLIST") continue;

        if (
            trimmed.startsWith("#EXTM3U") ||
            trimmed.startsWith("#EXT-X-VERSION") ||
            trimmed.startsWith("#EXT-X-TARGETDURATION") ||
            trimmed.startsWith("#EXT-X-MEDIA-SEQUENCE")
        ) {
            result.push(trimmed);
        } else if (trimmed.startsWith("#")) {
            metadataBuffer.push(trimmed);
        } else {
            if (keepSet.has(trimmed)) {
                result.push(...metadataBuffer);
                result.push(trimmed);
                metadataBuffer.length = 0;
            } else {
                metadataBuffer.length = 0;
            }
        }
    }

    result.push("#EXT-X-ENDLIST");
    return result.join("\n") + "\n";
}

export async function editVideo(filename: string, segments: string[], provider: string): Promise<void> {
    const paths = getProviderPaths(provider);
    const videoPath = await utils.findVideoPath(filename);
    if (!videoPath) throw new errors.FileNotFoundError(`Video folder not found: ${filename}`);

    const allFiles = await fsPromises.readdir(videoPath);
    const allSourceTsFiles = allFiles.filter((f) => f.endsWith(FILE_EXTENSIONS.TS));
    const segmentSet = new Set(segments);

    const validSegments = allSourceTsFiles.filter(f => segmentSet.has(f));

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

        const initFiles = allFiles.filter(f =>
            f === "init.mp4" || (f.startsWith("init_") && f.endsWith(".mp4"))
        );
        if (initFiles.length > 0) {
            await Promise.all(initFiles.map(f =>
                fsPromises.copyFile(path.join(videoPath, f), path.join(destinationPath, f))
            ));
        }

        const playlistPath = path.join(videoPath, FILE_NAMES.HLS_PLAYLIST);
        try {
            const originalPlaylist = await fsPromises.readFile(playlistPath, "utf-8");
            const editedPlaylist = deriveEditedPlaylist(originalPlaylist, segmentSet);
            await fsPromises.writeFile(
                path.join(destinationPath, FILE_NAMES.HLS_PLAYLIST),
                editedPlaylist,
                "utf-8"
            );
        } catch {
            // Original playlist unreadable — video will serve without a playlist (404)
        }

        logger.info(`Edited ${filename} with ${validSegments.length} segments at ${destinationPath}`);

        await moveService.moveVideo(filename, DESTINATIONS.TRASH, provider, videoPath);
        logger.info(`Successfully processed and removed original folder: ${filename}`);
    }
}