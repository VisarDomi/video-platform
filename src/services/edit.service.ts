// src/services/edit.service.ts
import { promises as fsPromises } from "fs";
import path from "path";
import { VIDEO_CONVERT_PATH } from "../config.js";
import logger from "../logger.js";
import * as utils from "../utils.js";
import * as errors from "../errors.js";
import * as metadataService from "./metadata.service.js";
import { moveVideo } from "./video.service.js";

async function getParts(videoPath: string, filename: string, tsFiles: string[]): Promise<string[][]> {
    const durations = await metadataService.cacheDurations(videoPath, filename, tsFiles);

    const parts: string[][] = [];
    if (tsFiles.length === 0) {
        return parts;
    }

    let tsChunk: string[] = [];
    let totalDuration = 0;

    for (const tsFile of tsFiles) {
        const tsDuration = durations.get(tsFile) || 0;
        tsChunk.push(tsFile);
        totalDuration += tsDuration;

        if (totalDuration > 30 * 60) {
            parts.push([...tsChunk]); // i don't trust passing references, better create a copy.
            tsChunk = [];
            totalDuration = 0;
        }
    }

    if (tsChunk.length > 0) {
        parts.push([...tsChunk]);
    }

    return parts;
}

async function createPlaylist(sourceVideoPath: string, tsChunk: string[], destinationPath: string): Promise<void> {
    interface PlaylistSegment {
        tags: string[];
        filename: string;
    }

    const playlistPath = path.join(sourceVideoPath, "playlist.m3u8");
    const playlistContent = await fsPromises.readFile(playlistPath, "utf-8");

    const lines = playlistContent.split("\n");
    const headerLines: string[] = [];
    const segments: PlaylistSegment[] = [];

    let headerDone = false;
    let currentTags: string[] = [];
    for (const line of lines) {
        if (line.trim() === "" || line.startsWith("#EXT-X-ENDLIST")) continue;

        if (!headerDone && !line.startsWith("#EXTINF")) {
            headerLines.push(line);
        } else {
            headerDone = true;
            if (line.startsWith("#")) {
                currentTags.push(line);
            } else if (line.trim().endsWith(".ts")) {
                segments.push({ tags: currentTags, filename: line.trim() });
                currentTags = [];
            }
        }
    }

    const tsFiles = new Set(tsChunk);
    const newPlaylistLines = [...headerLines];

    if (tsChunk.length > 0) {
        newPlaylistLines.push("#EXT-X-DISCONTINUITY");
    }

    for (const segment of segments) {
        if (tsFiles.has(segment.filename)) {
            newPlaylistLines.push(...segment.tags, segment.filename);
        }
    }

    newPlaylistLines.push("#EXT-X-ENDLIST");

    const newPlaylistContent = newPlaylistLines.join("\n");
    const newPlaylistPath = path.join(destinationPath, "playlist.m3u8");
    await fsPromises.writeFile(newPlaylistPath, newPlaylistContent, "utf-8");
}

export async function createEditedVideo(filename: string, segments: string[]): Promise<void> {
    const videoPath = await utils.findVideoPath(filename);
    if (!videoPath) throw new errors.FileNotFoundError(`Video folder not found: ${filename}`);
    const allSourceTsFiles = (await fsPromises.readdir(videoPath)).filter((f) => f.endsWith(".ts"));
    const segmentSet = new Set(segments);
    const goodTsFiles: Set<string> = new Set();
    for (const tsFile of allSourceTsFiles) {
        if (segmentSet.has(tsFile)) {
            goodTsFiles.add(tsFile);
        }
    }

    if (goodTsFiles.size > 0) {
        const sortedGoodTs = Array.from(goodTsFiles).sort((a, b) => parseInt(a.split(".ts")[0]) - parseInt(b.split(".ts")[0]));
        const parts: string[][] = await getParts(videoPath, filename, sortedGoodTs);

        for (let i = 0; i < parts.length; i++) {
            const tsChunk = parts[i];
            const partFolderName = parts.length > 1 ? `${filename} part${i + 1}` : filename;
            const destinationPath = path.join(VIDEO_CONVERT_PATH, partFolderName);
            await fsPromises.mkdir(destinationPath, { recursive: true });
            const movePromises = tsChunk.map((file) => fsPromises.rename(path.join(videoPath, file), path.join(destinationPath, file)));
            await Promise.all(movePromises);
            await createPlaylist(videoPath, tsChunk, destinationPath);
            logger.info(`Created part ${i + 1} for ${filename} with ${tsChunk.length} segments at ${destinationPath}`);
        }
    }

    await moveVideo(filename, "trash");
    logger.info(`Successfully processed and removed original folder: ${filename}`);
}
