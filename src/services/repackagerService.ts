// src/services/repackagerService.ts
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as timersPromises from 'timers/promises';
import * as path from 'path';

import * as config from '../config.js';
import logger from '../logger.js';
import * as storage from '../storage.js'; // <-- NEW IMPORT
import * as repackager from '../repackager.js';

async function getActiveDownloadAliasesFromFile(): Promise<Set<string>> {
    const statusFilePath = path.join(config.getConfig().storagePath, config.getConfig().fileNames.liveStatus);
    try {
        const data = await fsPromises.readFile(statusFilePath, 'utf-8');
        const status = JSON.parse(data);
        if (status?.activeDownloads && Array.isArray(status.activeDownloads)) {
            const aliases = status.activeDownloads.map((dl: any) => dl.alias);
            return new Set(aliases);
        }
    } catch (error: any) {
        if (error.code !== 'ENOENT') {
            logger.warn(`[Repackager] Could not read or parse live-status.json.`, { error });
        }
    }
    return new Set();
}

interface StorageContents {
    potentialFolders: fs.Dirent[];
    mp4FileNames: Set<string>;
    tsFileNames: Set<string>;
}

async function getStorageContents(storagePath: string): Promise<StorageContents | null> {
    try {
        const entries = await fsPromises.readdir(storagePath, { withFileTypes: true });
        
        const potentialFolders = entries.filter(e => e.isDirectory() && storage.parseDownloadFolderName(e.name)); // Use storage module

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

async function cleanupCompletedAssets(storagePath: string, contents: StorageContents): Promise<void> {
    const cfg = config.getConfig();

    for (const tsFile of contents.tsFileNames) {
        const baseName = path.parse(tsFile).name;
        if (contents.mp4FileNames.has(baseName)) {
            logger.info(`[Repackager Cleanup] Moving stale .ts file to trash: ${tsFile}`);
            await storage.moveToTrash(path.join(storagePath, tsFile)); // Use storage module
        }
    }

    if (cfg.repackager.deleteRawOnSuccess) {
        for (const folder of contents.potentialFolders) {
            if (contents.mp4FileNames.has(folder.name)) {
                logger.info(`[Repackager Cleanup] Moving stale segment folder to trash: ${folder.name}`);
                await storage.moveToTrash(path.join(storagePath, folder.name)); // Use storage module
            }
        }
    }
}

async function processCandidateFolder(folderPath: string): Promise<void> {
    const cfg = config.getConfig();
    const folderName = path.basename(folderPath);

    try {
        const dirEntries = await fsPromises.readdir(folderPath);
        if (dirEntries.length === 0) {
            logger.warn(`[Repackager] Found empty stale folder '${folderName}'. Moving to trash.`);
            if (cfg.repackager.deleteRawOnSuccess) {
                await storage.moveToTrash(folderPath); // Use storage module
                await storage.moveToTrash(path.join(path.dirname(folderPath), `${folderName}.ts`)); // Use storage module
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
        await fsPromises.access(mp4Path);
        if (cfg.repackager.deleteRawOnSuccess) {
            logger.info(`[Repackager] Repackage successful. Moving raw assets to trash for '${folderName}'.`);
            await storage.moveToTrash(folderPath); // Use storage module
            await storage.moveToTrash(path.join(path.dirname(folderPath), `${folderName}.ts`)); // Use storage module
        }
    } catch {
        logger.warn(`[Repackager] Repackage process for '${folderName}' finished, but output MP4 not found. Raw files will be kept.`);
    }
}

async function processCompletedDownloads() {
    logger.info("[Repackager] Scanning for completed downloads...");
    const cfg = config.getConfig();
    const storageDir = cfg.storagePath;

    const contents = await getStorageContents(storageDir);
    if (!contents) {
        return;
    }

    await cleanupCompletedAssets(storageDir, contents);

    const activeDownloadAliases = await getActiveDownloadAliasesFromFile();
    const staleTimeout = cfg.timeouts.staleStream * 2;

    for (const folder of contents.potentialFolders) {
        if (contents.mp4FileNames.has(folder.name)) {
            continue;
        }

        const parsedName = storage.parseDownloadFolderName(folder.name); // Use storage module
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