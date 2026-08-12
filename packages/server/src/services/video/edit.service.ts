import { promises as fsPromises } from "fs";
import { randomUUID } from "node:crypto";
import path from "path";
import { getProviderPaths } from "../../core/config.js";
import logger from "../../core/logger.js";
import type { VideoRef } from "../../core/types.js";
import { DESTINATIONS, FILE_EXTENSIONS, FILE_NAMES, HLS } from "../../core/constants.js";
import * as moveService from "./move.service.js";

interface DerivePlaylistResult {
    content: string;
    keptSegmentCount: number;
    isFmp4: boolean;
    hasMapTag: boolean;
}

interface SourcePlaylistEntry {
    readonly name: string;
    readonly sourceIndex: number;
    readonly metadata: string[];
    readonly mapLine: string | null;
}

async function syncPath(targetPath: string): Promise<void> {
    const handle = await fsPromises.open(targetPath, "r");
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function writeFileDurably(filePath: string, content: string): Promise<void> {
    const handle = await fsPromises.open(filePath, "wx");
    try {
        await handle.writeFile(content, "utf-8");
        await handle.sync();
    } finally {
        await handle.close();
    }
}

export function deriveEditedPlaylist(content: string, keepSet: Set<string>): DerivePlaylistResult {
    const lines = content.split("\n");
    const header: string[] = [];
    const entries: SourcePlaylistEntry[] = [];
    const metadataBuffer: string[] = [];
    let currentMap: string | null = null;
    const isFmp4 = content.includes(HLS.MAP_PREFIX);

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed === HLS.ENDLIST) continue;

        if (
            trimmed.startsWith("#EXTM3U") ||
            trimmed.startsWith("#EXT-X-VERSION") ||
            trimmed.startsWith("#EXT-X-TARGETDURATION") ||
            trimmed.startsWith("#EXT-X-MEDIA-SEQUENCE")
        ) {
            header.push(trimmed);
        } else if (trimmed.startsWith(HLS.MAP_PREFIX)) {
            currentMap = trimmed;
        } else if (trimmed.startsWith("#")) {
            metadataBuffer.push(trimmed);
        } else {
            entries.push({
                name: trimmed,
                sourceIndex: entries.length,
                metadata: [...metadataBuffer],
                mapLine: currentMap,
            });
            metadataBuffer.length = 0;
        }
    }

    const keptEntries = entries.filter((entry) => keepSet.has(entry.name));
    const result = [...header];
    let previous: SourcePlaylistEntry | null = null;
    let emittedMap: string | null = null;

    for (const entry of keptEntries) {
        const sourceDiscontinuity = entry.metadata.includes(HLS.DISCONTINUITY);
        const userCut = previous !== null && entry.sourceIndex !== previous.sourceIndex + 1;
        const mapChanged = previous !== null && entry.mapLine !== emittedMap;
        if (previous !== null && (sourceDiscontinuity || userCut || mapChanged)) {
            result.push(HLS.DISCONTINUITY);
        }
        if (entry.mapLine && entry.mapLine !== emittedMap) {
            result.push(entry.mapLine);
            emittedMap = entry.mapLine;
        }
        result.push(...entry.metadata.filter((metadata) => metadata !== HLS.DISCONTINUITY));
        result.push(entry.name);
        previous = entry;
    }

    result.push(HLS.ENDLIST);
    const hasMapTag = result.some(l => l.startsWith(HLS.MAP_PREFIX));
    return {
        content: result.join("\n") + "\n",
        keptSegmentCount: keptEntries.length,
        isFmp4,
        hasMapTag,
    };
}

export async function editVideo(ref: VideoRef, segments: string[]): Promise<void> {
    const paths = getProviderPaths(ref.provider);
    const videoPath = ref.dirPath;
    const filename = ref.filename;

    const allFiles = await fsPromises.readdir(videoPath);
    const allSourceTsFiles = allFiles.filter((f) => f.endsWith(FILE_EXTENSIONS.TS));
    const segmentSet = new Set(segments);

    const validSegments = allSourceTsFiles.filter(f => segmentSet.has(f));

    const initFiles = allFiles.filter(f =>
        f === "init.mp4" || (f.startsWith("init_") && f.endsWith(".mp4"))
    );
    const isFmp4 = initFiles.length > 0;

    logger.info(`[edit] ${filename} [${ref.provider}]: requested=${segments.length} matched=${validSegments.length} diskTs=${allSourceTsFiles.length} initFiles=${initFiles.length} isFmp4=${isFmp4}`);

    if (segments.length > 0 && validSegments.length === 0) {
        logger.error(`[edit] ${filename}: all ${segments.length} requested segments failed to match any of ${allSourceTsFiles.length} .ts files on disk. First requested: ${segments[0]}, first on disk: ${allSourceTsFiles[0] ?? "none"}`);
    } else if (validSegments.length < segments.length) {
        const missing = segments.filter(s => !allSourceTsFiles.includes(s));
        logger.warn(`[edit] ${filename}: ${missing.length} requested segments not found on disk: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "..." : ""}`);
    }

    if (validSegments.length === 0) {
        logger.warn(`[edit] ${filename}: no valid segments — skipping edit`);
        return;
    }

    const pendingRoot = path.join(paths.edited, ".pending");
    const pendingPath = path.join(pendingRoot, filename);
    const finalizedPath = path.join(paths.edited, filename);
    const buildingPath = path.join(pendingRoot, `.building-${randomUUID()}`);
    await fsPromises.mkdir(pendingRoot, { recursive: true });
    for (const destination of [pendingPath, finalizedPath]) {
        try {
            await fsPromises.lstat(destination);
            throw new Error(`Edited recording destination already exists: ${destination}`);
        } catch (error: any) {
            if (error?.code !== "ENOENT") throw error;
        }
    }
    await fsPromises.mkdir(buildingPath);

    const movePromises = validSegments.map((file) =>
        fsPromises.rename(path.join(videoPath, file), path.join(buildingPath, file))
    );
    await Promise.all(movePromises);

    if (initFiles.length > 0) {
        await Promise.all(initFiles.map(f =>
            fsPromises.copyFile(path.join(videoPath, f), path.join(buildingPath, f))
        ));
        await Promise.all(initFiles.map((file) => syncPath(path.join(buildingPath, file))));
        logger.info(`[edit] ${filename}: copied ${initFiles.length} init files: ${initFiles.join(", ")}`);
    }

    const playlistPath = path.join(videoPath, FILE_NAMES.HLS_PLAYLIST);
    const originalPlaylist = await fsPromises.readFile(playlistPath, "utf-8");
    const playlistResult = deriveEditedPlaylist(originalPlaylist, segmentSet);
    await writeFileDurably(
        path.join(buildingPath, FILE_NAMES.HLS_PLAYLIST),
        playlistResult.content,
    );
    logger.info(`[edit] ${filename}: playlist derived — keptSegments=${playlistResult.keptSegmentCount} isFmp4=${playlistResult.isFmp4} hasMapTag=${playlistResult.hasMapTag}`);
    if (playlistResult.isFmp4 && !playlistResult.hasMapTag) {
        throw new Error(`[edit] ${filename}: fmp4 playlist lost #EXT-X-MAP tag`);
    }

    await syncPath(buildingPath);
    await fsPromises.rename(buildingPath, pendingPath);
    await syncPath(pendingRoot);
    logger.info(`[edit] ${filename}: handed ${validSegments.length} edited segments to server validation at ${pendingPath}`);

    await moveService.moveVideo(ref, DESTINATIONS.TRASH);
    logger.info(`[edit] ${filename}: original moved to trash`);
}
