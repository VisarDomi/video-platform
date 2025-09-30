// src/assembler/assemblerService.ts
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as timersPromises from "timers/promises";
import * as path from "path";
import * as url from "url";

import * as config from "../common/config.js";
import logger from "../common/logger.js";
import * as storage from "../common/storage.js";
import * as utils from "../common/utils.js";

import * as assemblerUtils from "./assemblerUtils.js";
import { assembleSegmentsIntoMp4 } from "./assembler.js";

// --- Correct Path Resolution ---
const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = utils.findProjectRoot(__dirname)

async function getActiveDownloadAliasesFromFile(): Promise<Set<string>> {
    const statusFilePath = path.join(projectRoot, config.getConfig().fileNames.liveStatus);
    try {
        const data = await fsPromises.readFile(statusFilePath, "utf-8");
        const status = JSON.parse(data);
        if (status?.activeDownloads && Array.isArray(status.activeDownloads)) {
            const aliases = status.activeDownloads.map((dl: any) => dl.alias);
            return new Set(aliases);
        }
    } catch (error: any) {
        if (error.code !== "ENOENT") {
            logger.warn(`[Assembler] Could not read or parse live-status.json.`, { error });
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

        const potentialFolders = entries.filter((e) => e.isDirectory() && assemblerUtils.parseDownloadFolderName(e.name));

        const mp4FileNames = new Set(entries.filter((e) => e.isFile() && e.name.endsWith(".mp4")).map((e) => path.parse(e.name).name));

        const tsFileNames = new Set(entries.filter((e) => e.isFile() && e.name.endsWith(".ts")).map((e) => e.name));

        return { potentialFolders, mp4FileNames, tsFileNames };
    } catch (error: any) {
        if (error.code === "ENOENT") {
            logger.warn(`[Assembler] Storage path ${storagePath} does not exist. Skipping scan.`);
        } else {
            logger.error("[Assembler] Failed to scan storage directory.", { error });
        }
        return null;
    }
}

async function cleanupCompletedAssets(storagePath: string, contents: StorageContents): Promise<void> {
    const cfg = config.getConfig();

    for (const tsFile of contents.tsFileNames) {
        const baseName = path.parse(tsFile).name;
        if (contents.mp4FileNames.has(baseName)) {
            logger.info(`[Assembler Cleanup] Moving stale .ts file to trash: ${tsFile}`);
            await storage.moveToTrash(path.join(storagePath, tsFile));
        }
    }

    if (cfg.repackager.deleteRawOnSuccess) {
        for (const folder of contents.potentialFolders) {
            if (contents.mp4FileNames.has(folder.name)) {
                logger.info(`[Assembler Cleanup] Moving stale segment folder to trash: ${folder.name}`);
                await storage.moveToTrash(path.join(storagePath, folder.name));
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
            logger.warn(`[Assembler] Found empty stale folder '${folderName}'. Moving to trash.`);
            if (cfg.repackager.deleteRawOnSuccess) {
                await storage.moveToTrash(folderPath);
                await storage.moveToTrash(path.join(path.dirname(folderPath), `${folderName}.ts`));
            }
            return;
        }
    } catch (readError) {
        logger.error(`[Assembler] Could not read contents of folder '${folderName}'. Skipping.`, { readError });
        return;
    }

    logger.info(`[Assembler] Found stale, completed folder '${folderName}'. Starting processing.`);
    await assembleSegmentsIntoMp4(folderPath);

    const mp4Path = path.join(path.dirname(folderPath), `${folderName}.mp4`);
    try {
        await fsPromises.access(mp4Path);
        if (cfg.repackager.deleteRawOnSuccess) {
            logger.info(`[Assembler] Assembly successful. Moving raw assets to trash for '${folderName}'.`);
            await storage.moveToTrash(folderPath);
            await storage.moveToTrash(path.join(path.dirname(folderPath), `${folderName}.ts`));
        }
    } catch {
        logger.warn(`[Assembler] Assembly process for '${folderName}' finished, but output MP4 not found. Raw files will be kept.`);
    }
}

async function processCompletedDownloads() {
    logger.info("[Assembler] Scanning for completed downloads...");
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

        const parsedName = assemblerUtils.parseDownloadFolderName(folder.name);
        if (!parsedName || activeDownloadAliases.has(parsedName.alias)) {
            logger.verbose(`[Assembler] Skipping folder for active or unparsable alias: ${folder.name}`);
            continue;
        }

        const fullFolderPath = path.join(storageDir, folder.name);
        try {
            const stats = await fsPromises.stat(fullFolderPath);
            const isStale = Date.now() - stats.mtime.getTime() > staleTimeout;

            if (isStale) {
                await processCandidateFolder(fullFolderPath);
            } else {
                logger.verbose(`[Assembler] Folder '${folder.name}' is not stale yet. Skipping.`);
            }
        } catch (statError) {
            logger.error(`[Assembler] Could not stat folder '${folder.name}'. Skipping.`, { error: statError });
        }
    }
    logger.info("[Assembler] Scan complete.");
}

export async function startAssemblerService() {
    logger.info("Starting segment assembler service...");
    if (config.getConfig().repackager.enabled) {
        await processCompletedDownloads();
    }

    while (true) {
        const scanInterval = config.getConfig().intervals.repackageScanMinutes * 60 * 1000;
        await timersPromises.setTimeout(scanInterval);

        try {
            if (config.getConfig().repackager.enabled) {
                logger.info("Periodic segment assembly scan triggered by manager.");
                await processCompletedDownloads();
            } else {
                logger.verbose("Segment assembler is disabled, skipping periodic scan.");
            }
        } catch (error) {
            logger.error("An unexpected error occurred in the assembler service loop.", { error });
        }
    }
}
