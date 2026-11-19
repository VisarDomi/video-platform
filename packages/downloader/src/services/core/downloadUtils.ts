import * as path from "path";
import { providerFolder } from "shared";
import { FileSystemManager } from "../../common/fileSystemManager.js";
import logger from "../../common/logger.js";
import { formatTimestampForPath } from "../../common/pathTimestamp.js";

// URL resolution and request signals are shared with the site plug-ins.
export { requestSignal, resolveSegmentUrl } from "sdk";

export function formatDownloadDirName(alias: string, date: Date): string {
    return `${formatTimestampForPath(date)} ${alias}`;
}

export async function setupDownloadDir(providerName: string, alias: string, date: Date): Promise<string | null> {
    const baseName = formatDownloadDirName(alias, date);
    const storageLocation = path.join(providerFolder(providerName, "downloaded"), ".active");

    const storageLocationExists = await FileSystemManager.ensureDirExists(storageLocation);
    if (!storageLocationExists) {
        logger.error(`[${providerName}] Could not create or access storage folder at: ${storageLocation}`);
        return null;
    }

    const segmentsDirPath = path.resolve(storageLocation, baseName);
    const segmentsDirExists = await FileSystemManager.ensureDirExists(segmentsDirPath);
    return segmentsDirExists ? segmentsDirPath : null;
}
