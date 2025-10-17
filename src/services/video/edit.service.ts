import { promises as fsPromises } from "fs";
import path from "path";
import { VIDEO_EDITED_PATH } from "../../core/config.js";
import logger from "../../core/logger.js";
import * as utils from "../../core/utils.js";
import * as errors from "../../core/errors.js";
import { DESTINATIONS, FILE_EXTENSIONS, FILE_NAMES, HLS, MISC } from "../../core/constants.js";
import * as metadataService from "../cache/disk/metadata.service.js";
import * as moveService from "./move.service.js";
import { fixAndCachePlaylist } from "../cache/memory/cache.service.js";

async function getParts(tsFiles: string[], metadata: Map<string, metadataService.SegmentMetadata>): Promise<string[][]> {
    const parts: string[][] = [];
    if (tsFiles.length === 0) {
        return parts;
    }

    let tsChunk: string[] = [];
    let totalDuration = 0;

    for (const tsFile of tsFiles) {
        const tsDuration = metadata.get(tsFile)?.duration || 0;
        tsChunk.push(tsFile);
        totalDuration += tsDuration;

        if (totalDuration > 30 * 60) {
            parts.push([...tsChunk]);
            tsChunk = [];
            totalDuration = 0;
        }
    }

    if (tsChunk.length > 0) {
        parts.push([...tsChunk]);
    }

    return parts;
}

async function createPlaylist(
    sourceVideoPath: string,
    tsChunk: string[],
    destinationPath: string,
    metadata: Map<string, metadataService.SegmentMetadata>
): Promise<void> {
    interface PlaylistSegment {
        tags: string[];
        filename: string;
    }

    const playlistPath = path.join(sourceVideoPath, FILE_NAMES.HLS_PLAYLIST);
    const playlistContent = await fsPromises.readFile(playlistPath, MISC.ENCODING_UTF8);

    const lines = playlistContent.split("\n");
    const headerLines: string[] = [];
    const segments: PlaylistSegment[] = [];

    let headerDone = false;
    let currentTags: string[] = [];
    for (const line of lines) {
        if (line.trim() === MISC.EMPTY_STRING || line.startsWith(HLS.ENDLIST)) continue;

        if (!headerDone && !line.startsWith(HLS.INF_PREFIX)) {
            headerLines.push(line);
        } else {
            headerDone = true;
            if (line.startsWith("#")) {
                currentTags.push(line);
            } else if (line.trim().endsWith(FILE_EXTENSIONS.TS)) {
                segments.push({ tags: currentTags, filename: line.trim() });
                currentTags = [];
            }
        }
    }

    const tsFiles = new Set(tsChunk);
    const newPlaylistLines = [...headerLines];

    const keptSegments = segments.filter((segment) => tsFiles.has(segment.filename));

    if (keptSegments.length > 0) {
        const firstKeptSegmentIndex = segments.findIndex((s) => s.filename === keptSegments[0].filename);

        let lastSegmentNumber: number;
        let lastResolution: string | null = null;

        if (firstKeptSegmentIndex > 0) {
            const segmentBefore = segments[firstKeptSegmentIndex - 1];
            lastSegmentNumber = parseInt(segmentBefore.filename.split(FILE_EXTENSIONS.TS)[0], 10);
            lastResolution = metadata.get(segmentBefore.filename)?.resolution || null;
        } else {
            const firstSegmentNumber = parseInt(keptSegments[0].filename.split(FILE_EXTENSIONS.TS)[0], 10);
            lastSegmentNumber = firstSegmentNumber - 1;
        }

        for (const segment of keptSegments) {
            const currentSegmentNumber = parseInt(segment.filename.split(FILE_EXTENSIONS.TS)[0], 10);
            const currentResolution = metadata.get(segment.filename)?.resolution || null;

            if (currentSegmentNumber !== lastSegmentNumber + 1 || (lastResolution && currentResolution && lastResolution !== currentResolution)) {
                newPlaylistLines.push(HLS.DISCONTINUITY);
            }

            newPlaylistLines.push(...segment.tags, segment.filename);
            lastSegmentNumber = currentSegmentNumber;
            lastResolution = currentResolution;
        }
    }

    newPlaylistLines.push(HLS.ENDLIST);

    const newPlaylistContent = newPlaylistLines.join("\n");
    const newPlaylistPath = path.join(destinationPath, FILE_NAMES.HLS_PLAYLIST);
    await fsPromises.writeFile(newPlaylistPath, newPlaylistContent, MISC.ENCODING_UTF8);
}

export async function editVideo(filename: string, segments: string[]): Promise<void> {
    const videoPath = await utils.findVideoPath(filename);
    if (!videoPath) throw new errors.FileNotFoundError(`Video folder not found: ${filename}`);
    const allSourceTsFiles = (await fsPromises.readdir(videoPath)).filter((f) => f.endsWith(FILE_EXTENSIONS.TS));
    const segmentSet = new Set(segments);
    const goodTsFiles: Set<string> = new Set();
    for (const tsFile of allSourceTsFiles) {
        if (segmentSet.has(tsFile)) {
            goodTsFiles.add(tsFile);
        }
    }

    if (goodTsFiles.size > 0) {
        const sortedGoodTs = Array.from(goodTsFiles).sort((a, b) => parseInt(a.split(FILE_EXTENSIONS.TS)[0]) - parseInt(b.split(FILE_EXTENSIONS.TS)[0]));
        const metadata = await metadataService.cacheMetadata(videoPath, filename, sortedGoodTs);
        const parts: string[][] = await getParts(sortedGoodTs, metadata);

        for (let i = 0; i < parts.length; i++) {
            const tsChunk = parts[i];
            const partFolderName = parts.length > 1 ? `${filename}${MISC.EDITED_VIDEO_PART_SUFFIX(i + 1)}` : filename;
            const destinationPath = path.join(VIDEO_EDITED_PATH, partFolderName);
            await fsPromises.mkdir(destinationPath, { recursive: true });
            const movePromises = tsChunk.map((file) => fsPromises.rename(path.join(videoPath, file), path.join(destinationPath, file)));
            await Promise.all(movePromises);
            await createPlaylist(videoPath, tsChunk, destinationPath, metadata);
            await fixAndCachePlaylist(destinationPath, partFolderName);
            logger.info(`Created part ${i + 1} for ${filename} with ${tsChunk.length} segments at ${destinationPath}`);
        }

        await moveService.moveVideo(filename, DESTINATIONS.TRASH, videoPath);
        logger.info(`Successfully processed and removed original folder: ${filename}`);
    }
}
