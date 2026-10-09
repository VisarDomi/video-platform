import * as path from "path";
import { providerFolder } from "shared";
import { FileSystemManager } from "../../common/fileSystemManager.js";
import logger from "../../common/logger.js";
import { formatTimestampForPath } from "../../common/pathTimestamp.js";

export function resolveSegmentUrl(baseUrl: string, segmentLine: string): string {
    try {
        return new URL(segmentLine, baseUrl).href;
    } catch {
        return segmentLine;
    }
}

// AbortSignal.any exists at runtime (Node 20.3+); the pinned @types/node predates it.
const AnyAbortSignal = AbortSignal as typeof AbortSignal & { any(signals: AbortSignal[]): AbortSignal };

// A request's own timeout, plus the caller's signal when it has one.
export function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal ? AnyAbortSignal.any([signal, timeout]) : timeout;
}

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
