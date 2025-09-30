// src/services/repackagerService.ts
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as timersPromises from 'timers/promises';
import * as path from 'path';

import * as config from '../config.js';
import logger from '../logger.js';
import * as utils from '../utils.js';
import * as state from '../state.js';
import * as repackager from '../repackager.js';

/**
 * Represents the contents of the storage directory, categorized for processing.
 */
interface StorageContents {
    potentialFolders: fs.Dirent[];
    mp4FileNames: Set<string>; // Basename without extension
    tsFileNames: Set<string>; // Basename with extension
}

/**
 * Reads the storage directory and categorizes its contents.
 */
async function getStorageContents(storagePath: string): Promise<StorageContents | null> {
    try {
        const entries = await fsPromises.readdir(storagePath, { withFileTypes: true });
        
        const potentialFolders = entries.filter(e => e.isDirectory() && utils.parseDownloadFolderName(e.name));

        const mp4FileNames = new Set(
            entries.filter(e => e.isFile() && e.name.endsWith('.mp4')).map(e => path.parse(e.name).name)
        );

        const tsFileNames = new Set(
            entries.filter(e => e.isFile() && e.name.endsWith('.ts')).map(e => e.name)
        );

        return { potentialFolders, mp4FileNames, tsFileNames };

    } catch (error: any) {
        if (error.code === 'ENOENT') {
            logger.warn(`[Repackager] Storage path ${storagePath} does not exist. Skipping scan.`);
        } else {
            logger.error("[Repackager] Failed to scan storage directory.", { error });
        }
        return null;
    }
}

/**
 * Cleans up raw assets (.ts file and segment folder) if a corresponding .mp4 already exists.
 */
async function cleanupCompletedAssets(storagePath: string, contents: StorageContents): Promise<void> {
    const cfg = config.getConfig();

    // Cleanup stale .ts files that have a matching .mp4
    for (const tsFile of contents.tsFileNames) {
        const baseName = path.parse(tsFile).name;
        if (contents.mp4FileNames.has(baseName)) {
            logger.info(`[Repackager Cleanup] Moving stale .ts file to trash: ${tsFile}`);
            await utils.moveToTrash(path.join(storagePath, tsFile));
        }
    }

    // If configured, cleanup segment folders that have a matching .mp4
    if (cfg.repackager.deleteRawOnSuccess) {
        for (const folder of contents.potentialFolders) {
            if (contents.mp4FileNames.has(folder.name)) {
                logger.info(`[Repackager Cleanup] Moving stale segment folder to trash: ${folder.name}`);
                await utils.moveToTrash(path.join(storagePath, folder.name));
            }
        }
    }
}

/**
 * Processes a single candidate folder: repackages and optionally cleans up.
 */
async function processCandidateFolder(folderPath: string): Promise<void> {
    const cfg = config.getConfig();
    const folderName = path.basename(folderPath);

    try {
        const dirEntries = await fsPromises.readdir(folderPath);
        if (dirEntries.length === 0) {
            logger.warn(`[Repackager] Found empty stale folder '${folderName}'. Moving to trash.`);
            if (cfg.repackager.deleteRawOnSuccess) {
                await utils.moveToTrash(folderPath);
                // Also trash the corresponding large .ts file if it exists
                await utils.moveToTrash(path.join(path.dirname(folderPath), `${folderName}.ts`));
            }
            return;
        }
    } catch (readError) {
        logger.error(`[Repackager] Could not read contents of folder '${folderName}'. Skipping.`, { readError });
        return;
    }

    logger.info(`[Repackager] Found stale, completed folder '${folderName}'. Starting processing.`);
    await repackager.repackageFolder(folderPath);

    const mp4Path = path.join(path.dirname(folderPath), `${folderName}.mp4`);
    try {
        await fsPromises.access(mp4Path); // Check if repackage created the file
        if (cfg.repackager.deleteRawOnSuccess) {
            logger.info(`[Repackager] Repackage successful. Moving raw assets to trash for '${folderName}'.`);
            await utils.moveToTrash(folderPath);
            await utils.moveToTrash(path.join(path.dirname(folderPath), `${folderName}.ts`));
        }
    } catch {
        logger.warn(`[Repackager] Repackage process for '${folderName}' finished, but output MP4 not found. Raw files will be kept.`);
    }
}

/**
 * The main orchestrator for scanning and processing completed downloads.
 */
async function processCompletedDownloads() {
    logger.info("[Repackager] Scanning for completed downloads...");
    const cfg = config.getConfig();
    const storageDir = cfg.storagePath;

    const contents = await getStorageContents(storageDir);
    if (!contents) {
        return; // Error already logged by getStorageContents
    }

    // First, clean up any assets from previous successful runs
    await cleanupCompletedAssets(storageDir, contents);

    const activeDownloadAliases = new Set(Array.from(state.getActiveDownloads().values(), dl => dl.alias));
    const staleTimeout = cfg.timeouts.staleStream * 2;

    for (const folder of contents.potentialFolders) {
        // Skip if an MP4 already exists (already handled by cleanup, but a good safeguard)
        if (contents.mp4FileNames.has(folder.name)) {
            continue;
        }

        const parsedName = utils.parseDownloadFolderName(folder.name);
        if (!parsedName || activeDownloadAliases.has(parsedName.alias)) {
            logger.verbose(`[Repackager] Skipping folder for active or unparsable alias: ${folder.name}`);
            continue;
        }

        const fullFolderPath = path.join(storageDir, folder.name);
        try {
            const stats = await fsPromises.stat(fullFolderPath);
            const isStale = (Date.now() - stats.mtime.getTime()) > staleTimeout;

            if (isStale) {
                await processCandidateFolder(fullFolderPath);
            } else {
                logger.verbose(`[Repackager] Folder '${folder.name}' is not stale yet. Skipping.`);
            }
        } catch (statError) {
            logger.error(`[Repackager] Could not stat folder '${folder.name}'. Skipping.`, { error: statError });
        }
    }
    logger.info("[Repackager] Scan complete.");
}


/**
 * Starts the main loop for periodically scanning for completed downloads to repackage.
 * This function does not return and runs indefinitely.
 */
export async function startRepackagerService() {
    logger.info("Starting repackager service...");
    if (config.getConfig().repackager.enabled) {
        await processCompletedDownloads();
    }

    while (true) {
        const scanInterval = config.getConfig().intervals.repackageScanMinutes * 60 * 1000;
        await timersPromises.setTimeout(scanInterval);

        try {
            if (config.getConfig().repackager.enabled) {
                logger.info("Periodic repackage scan triggered by manager.");
                await processCompletedDownloads();
            } else {
                logger.verbose("Repackager is disabled, skipping periodic scan.");
            }
        } catch (error) {
            logger.error("An unexpected error occurred in the repackager manager loop.", { error });
        }
    }
}