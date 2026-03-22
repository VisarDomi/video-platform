import { promises as fsPromises } from "fs";
import path from "path";
import logger from "./logger.js";
import { FILE_NAMES, MISC } from "./constants.js";
import { fixTargetDuration } from "shared";

const playlistPromises = new Map<string, Promise<void>>();

export function ensurePlaylist(videoPath: string): Promise<void> {
    const playlistPath = path.join(videoPath, FILE_NAMES.HLS_PLAYLIST);

    const existing = playlistPromises.get(playlistPath);
    if (existing) return existing;

    const promise = (async () => {
        let content: string;
        try {
            content = await fsPromises.readFile(playlistPath, MISC.ENCODING_UTF8);
        } catch {
            return;
        }

        const { content: fixed, wasFixed } = fixTargetDuration(content);
        if (wasFixed) {
            await fsPromises.writeFile(playlistPath, fixed, MISC.ENCODING_UTF8);
            logger.info(`Fixed TARGETDURATION in ${playlistPath}`);
        }
    })();

    playlistPromises.set(playlistPath, promise);
    return promise;
}
