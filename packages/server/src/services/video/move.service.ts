import { promises as fsPromises } from "fs";
import path from "path";
import { FINALIZATION_DB_PATH, getProviderPaths } from "../../core/config.js";
import logger from "../../core/logger.js";
import { DESTINATIONS, FILE_NAMES, LOGS } from "../../core/constants.js";
import * as types from "../../core/types.js";
import * as errors from "../../core/errors.js";
import { FinalizationCheckpointStore, playlistFingerprint } from "../hls/finalizationCheckpointStore.js";

async function syncDirectory(directory: string): Promise<void> {
    const handle = await fsPromises.open(directory, "r");
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function currentFingerprint(folder: string): Promise<string | null> {
    try {
        return playlistFingerprint(await fsPromises.readFile(path.join(folder, FILE_NAMES.HLS_PLAYLIST), "utf-8"));
    } catch (error: any) {
        if (error?.code === "ENOENT") return null;
        throw error;
    }
}

// Moves a recording's folder (save, trash, restore). Its finalization checkpoint moves with it:
// a saved recording is as validated as it was at capture, so the pipeline can upload it, exactly
// like a cut. The checkpoint is written at the new path first, both folders are synced after the
// rename, and only then is the old row cleared, so a power cut leaves the recording with a
// checkpoint wherever it ends up.
export async function moveVideo(
    ref: types.VideoRef,
    destination: types.Destination,
    options: { finalizationDatabasePath?: string } = {},
): Promise<void> {
    const paths = getProviderPaths(ref.provider);

    let newPath: string;
    if (destination === DESTINATIONS.TRASH) {
        newPath = paths.trash;
    } else if (destination === DESTINATIONS.ORIGINAL) {
        newPath = paths.downloaded;
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

        const fingerprint = await currentFingerprint(videoPath);
        const checkpoints = new FinalizationCheckpointStore(options.finalizationDatabasePath ?? FINALIZATION_DB_PATH);
        try {
            const carried = fingerprint !== null && checkpoints.carry(videoPath, destinationPath, fingerprint);
            try {
                await fsPromises.rename(videoPath, destinationPath);
            } catch (error) {
                if (carried) checkpoints.clear(destinationPath);
                throw error;
            }
            await syncDirectory(newPath);
            await syncDirectory(path.dirname(videoPath));
            checkpoints.clear(videoPath);
            logger.info(`Moved folder from ${videoPath} to: ${destinationPath}`
                + (carried ? " (with its finalization checkpoint)" : ""));
        } finally {
            checkpoints.close();
        }
    } else {
        throw new errors.MoveError(LOGS.MESSAGES.MOVE_ERROR);
    }
}
