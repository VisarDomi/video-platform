// src/services/repackagerService.ts
import * as fsPromises from 'fs/promises';
import * as timersPromises from 'timers/promises';
import * as path from 'path';

import * as config from '../config.js';
import logger from '../logger.js';
import * as utils from '../utils.js';
import * as state from '../state.js';
import * as repackager from '../repackager.js';

async function processCompletedDownloads() {
    logger.info("[Repackager] Scanning storage path for completed downloads...");
    const cfg = config.getConfig();
    const storageDir = cfg.storagePath;

    try {
        const entries = await fsPromises.readdir(storageDir, { withFileTypes: true });
        
        const downloadFolderPattern = /^\d{4}-\d{2}-\d{2} \d{6} .+/;
        const potentialFolders = entries.filter(e => e.isDirectory() && downloadFolderPattern.test(e.name));

        const mp4Files = new Set(
            entries.filter(e => e.isFile() && e.name.endsWith('.mp4')).map(e => path.parse(e.name).name)
        );

        const tsFilesWithExt = new Set(
             entries.filter(e => e.isFile() && e.name.endsWith('.ts')).map(e => e.name)
        );

        for (const tsFile of tsFilesWithExt) {
            const baseName = path.parse(tsFile).name;
            if (mp4Files.has(baseName)) {
                const tsFilePath = path.join(storageDir, tsFile);
                logger.info(`[Repackager Cleanup] Moving stale .ts file to trash: ${tsFile}`);
                await utils.moveToTrash(tsFilePath);
            }
        }

        if (potentialFolders.length === 0) {
            logger.info("[Repackager] No download folders found to scan.");
            return;
        }
        
        for (const folder of potentialFolders) {
            if (folder.name === 'trash') continue;
            if (folder.name === 'edit') continue;

            const fullFolderPath = path.join(storageDir, folder.name);

            if (mp4Files.has(folder.name)) {
                if (cfg.repackager.deleteRawOnSuccess) {
                    logger.info(`[Repackager] Moving stale segment folder to trash: ${folder.name}`);
                    await utils.moveToTrash(fullFolderPath);
                }
                continue;
            }
            
            const isActive = Array.from(state.getActiveDownloads().values()).some(dl => {
                return folder.name.endsWith(dl.alias);
            });
            if (isActive) {
                logger.verbose(`[Repackager] Skipping all folders that have the same alias as ${folder.name}`);
                continue;
            }
            
            const stats = await fsPromises.stat(fullFolderPath);
            const staleTimeout = cfg.timeouts.staleStream * 2; 
            const isStale = (Date.now() - stats.mtime.getTime()) > staleTimeout;
            
            if (isStale) {
                try {
                    const dirEntries = await fsPromises.readdir(fullFolderPath);
                    if (dirEntries.length === 0) {
                        logger.warn(`[Repackager] Found empty stale folder '${folder.name}'. Moving to trash.`);
                        if (cfg.repackager.deleteRawOnSuccess) {
                            await utils.moveToTrash(fullFolderPath);
                            const bigTsFilePath = path.join(storageDir, `${folder.name}.ts`);
                            await utils.moveToTrash(bigTsFilePath);
                        }
                        continue;
                    }
                } catch (readError) {
                    logger.error(`[Repackager] Could not read contents of folder '${folder.name}'. Skipping.`, { readError });
                    continue;
                }

                logger.info(`[Repackager] Found stale, completed folder '${folder.name}'. Starting processing.`);
                await repackager.repackageFolder(fullFolderPath);

                if (cfg.repackager.deleteRawOnSuccess) {
                    await utils.moveToTrash(fullFolderPath);
                    const bigTsFilePath = path.join(storageDir, `${folder.name}.ts`);
                    await utils.moveToTrash(bigTsFilePath);
                }
            } else {
                 logger.verbose(`[Repackager] Folder '${folder.name}' is not stale yet. Skipping.`);
            }
        }
        logger.info("[Repackager] Scan complete.");

    } catch (error: any) {
        if (error.code === 'ENOENT') {
             logger.warn(`[Repackager] Storage path ${storageDir} does not exist. Skipping scan.`);
        } else {
            logger.error("[Repackager] Failed to scan for completed folders.", { error });
        }
    }
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
    
    while(true) {
        const scanInterval = config.getConfig().intervals.repackageScanMinutes * 60 * 1000;
        await timersPromises.setTimeout(scanInterval);

        try {
            if (config.getConfig().repackager.enabled) {
                logger.info("Periodic repackage scan triggered by manager.");
                await processCompletedDownloads();
            } else {
                logger.verbose("Repackager is disabled, skipping periodic scan.");
            }
        } catch(error) {
            logger.error("An unexpected error occurred in the repackager manager loop.", { error });
        }
    }
}