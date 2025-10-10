// src/services/video.service.ts
import { promises as fsPromises } from "fs";
import path from "path";
import { VIDEO_DOWNLOAD_PATH, VIDEO_CONVERT_PATH, VIDEO_MODIFIED_PATH, VIDEO_TRASH_PATH } from "../config.js";
import logger from "../logger.js";
import { FileNotFoundError } from "../errors.js";

type VideoItem = {
    filename: string;
    type: "original" | "edited";
    size: number;
};
type MetadataCache = { segments: Record<string, { resolution: string }> };

// ... (getVideosFromDir, findVideoPath, and generateMetadataAndPlaylist helpers are unchanged) ...

async function getVideosFromDir(dirPath: string, type: "original" | "edited"): Promise<VideoItem[]> {
    const videoItems: VideoItem[] = [];
    try {
        await fsPromises.mkdir(dirPath, { recursive: true });
        const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const videoFolderPath = path.join(dirPath, entry.name);
                try {
                    const files = await fsPromises.readdir(videoFolderPath);
                    if (files.some((f) => f.endsWith(".ts"))) videoItems.push({ filename: entry.name, type, size: 0 });
                } catch (err) {
                    logger.warn(`Could not read subdirectory ${videoFolderPath}`, { err });
                }
            }
        }
    } catch (error) {
        logger.error(`Could not read directory: ${dirPath}`, { error });
    }
    return videoItems;
}

async function findVideoPath(type: "original" | "edited", folderName: string): Promise<{ fullPath: string; baseDir: string } | null> {
    if (type === "original") {
        const fullPath = path.join(VIDEO_DOWNLOAD_PATH, folderName);
        try {
            await fsPromises.access(fullPath);
            return { fullPath, baseDir: VIDEO_DOWNLOAD_PATH };
        } catch {
            /* not found */
        }
    } else {
        const convertPath = path.join(VIDEO_CONVERT_PATH, folderName);
        try {
            await fsPromises.access(convertPath);
            return { fullPath: convertPath, baseDir: VIDEO_CONVERT_PATH };
        } catch {
            /* not in convert */
        }
        const modifiedPath = path.join(VIDEO_MODIFIED_PATH, folderName);
        try {
            await fsPromises.access(modifiedPath);
            return { fullPath: modifiedPath, baseDir: VIDEO_MODIFIED_PATH };
        } catch {
            /* not in modified */
        }
    }
    return null;
}

async function generateMetadataAndPlaylist(folderPath: string, folderName: string, tsFiles: string[], originalMetadata: MetadataCache): Promise<void> {
    if (tsFiles.length === 0) return;
    const newMetadata: MetadataCache = { segments: {} };
    for (const tsFile of tsFiles) {
        if (originalMetadata.segments[tsFile]) {
            newMetadata.segments[tsFile] = originalMetadata.segments[tsFile];
        }
    }
    await fsPromises.writeFile(path.join(folderPath, "metadata.json"), JSON.stringify(newMetadata, null, 2));
    const segmentLines = tsFiles.flatMap((segment) => [`#EXTINF:1.000,`, `/hls/edited/${folderName}/${segment}`]);
    const content = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:2", ...segmentLines, "#EXT-X-ENDLIST"].join("\n");
    await fsPromises.writeFile(path.join(folderPath, "playlist.m3u8"), content);
}

// ... (getAllVideos, getAllVideoDurations, trashVideo, moveVideoToEdited are unchanged) ...

export async function getAllVideos(): Promise<VideoItem[]> {
    const downloadPromise = getVideosFromDir(VIDEO_DOWNLOAD_PATH, "original");
    const convertPromise = getVideosFromDir(VIDEO_CONVERT_PATH, "edited");
    const modifiedPromise = getVideosFromDir(VIDEO_MODIFIED_PATH, "edited");
    const [downloadVideos, convertVideos, modifiedVideos] = await Promise.all([downloadPromise, convertPromise, modifiedPromise]);
    return [...downloadVideos, ...convertVideos, ...modifiedVideos].sort((a, b) => a.filename.localeCompare(b.filename));
}

export async function getAllVideoDurations(): Promise<Record<string, number>> {
    const allVideos = await getAllVideos();
    const durations: Record<string, number> = {};
    for (const video of allVideos) {
        let videoFolderPath: string;
        if (video.type === "original") videoFolderPath = path.join(VIDEO_DOWNLOAD_PATH, video.filename);
        else {
            const convertPath = path.join(VIDEO_CONVERT_PATH, video.filename);
            try {
                await fsPromises.access(convertPath);
                videoFolderPath = convertPath;
            } catch {
                videoFolderPath = path.join(VIDEO_MODIFIED_PATH, video.filename);
            }
        }
        try {
            const files = await fsPromises.readdir(videoFolderPath);
            durations[video.filename] = files.filter((f) => f.endsWith(".ts")).length;
        } catch (err) {
            logger.warn(`Could not calculate duration for ${video.filename}`, { err });
        }
    }
    return durations;
}

export async function trashVideo(type: "original" | "edited", folderName: string): Promise<void> {
    const foundVideo = await findVideoPath(type, folderName);
    if (!foundVideo) throw new FileNotFoundError(`Video folder not found: ${folderName}`);
    const destinationPath = path.join(VIDEO_TRASH_PATH, folderName);
    await fsPromises.rename(foundVideo.fullPath, destinationPath);
    logger.info(`Moved folder to trash: ${destinationPath}`);
}

export async function moveVideoToEdited(type: "original", folderName: string): Promise<void> {
    if (type !== "original") throw new Error("Only original videos can be moved.");
    const foundVideo = await findVideoPath(type, folderName);
    if (!foundVideo) throw new FileNotFoundError(`Original video folder not found: ${folderName}`);
    const destinationPath = path.join(VIDEO_CONVERT_PATH, folderName);
    await fsPromises.mkdir(VIDEO_CONVERT_PATH, { recursive: true });
    await fsPromises.rename(foundVideo.fullPath, destinationPath);
    logger.info(`Moved video to convert folder: ${destinationPath}`);
}

export async function returnVideoToOriginals(folderName: string): Promise<void> {
    const foundVideo = await findVideoPath("edited", folderName);
    if (!foundVideo) {
        throw new FileNotFoundError(`Edited video folder not found: ${folderName}`);
    }
    const destinationPath = path.join(VIDEO_DOWNLOAD_PATH, folderName);
    await fsPromises.rename(foundVideo.fullPath, destinationPath);
    logger.info(`Returned video to originals: ${destinationPath}`);

    // WHY THE FIX: After moving the folder, we must rewrite the playlist to use the correct 'original' type in its URLs.
    const playlistPath = path.join(destinationPath, "playlist.m3u8");
    try {
        const playlistContent = await fsPromises.readFile(playlistPath, "utf-8");
        const updatedContent = playlistContent.replace(/\/hls\/edited\//g, "/hls/original/");
        await fsPromises.writeFile(playlistPath, updatedContent, "utf-8");
        logger.info(`Updated playlist paths for ${folderName}`);
    } catch (error) {
        logger.warn(`Could not update playlist for returned video ${folderName}. It may need regeneration.`, { error });
    }
}

export async function createEditedVideo(filename: string, segments: { start: number; end: number }[]): Promise<void> {
    const foundVideo = await findVideoPath("original", filename);
    if (!foundVideo) throw new FileNotFoundError(`Original video file not found: ${filename}`);

    const sourceFolderPath = foundVideo.fullPath;

    const originalMetadata: MetadataCache = JSON.parse(await fsPromises.readFile(path.join(sourceFolderPath, "metadata.json"), "utf-8"));
    const allSourceTsFiles = (await fsPromises.readdir(sourceFolderPath)).filter((f) => f.endsWith(".ts"));

    const goodTsFiles = new Set<string>();
    const segmentIndexes = new Set<number>();
    for (const seg of segments) {
        for (let i = Math.floor(seg.start); i < Math.floor(seg.end); i++) {
            segmentIndexes.add(i);
        }
    }
    const badTsFiles: string[] = [];
    for (const tsFile of allSourceTsFiles) {
        const index = parseInt(tsFile, 10);
        if (segmentIndexes.has(index)) {
            goodTsFiles.add(tsFile);
        } else {
            badTsFiles.push(tsFile);
        }
    }

    if (badTsFiles.length > 0) {
        const trashFolderPath = path.join(VIDEO_TRASH_PATH, filename);
        await fsPromises.mkdir(trashFolderPath, { recursive: true });
        const movePromises = badTsFiles.map((file) => fsPromises.rename(path.join(sourceFolderPath, file), path.join(trashFolderPath, file)));
        await Promise.all(movePromises);
        await generateMetadataAndPlaylist(trashFolderPath, filename, badTsFiles, originalMetadata);
        logger.info(`Moved ${badTsFiles.length} bad segments to ${trashFolderPath}`);
    }

    if (goodTsFiles.size > 0) {
        const sortedGoodTs = Array.from(goodTsFiles).sort((a, b) => parseInt(a) - parseInt(b));
        const totalDuration = sortedGoodTs.length;
        const MAX_DURATION_SECONDS = 25 * 60;
        const numParts = Math.ceil(totalDuration / MAX_DURATION_SECONDS);

        for (let i = 0; i < numParts; i++) {
            const partFolderName = numParts > 1 ? `${filename} part${i + 1}` : filename;
            const partFolderPath = path.join(VIDEO_CONVERT_PATH, partFolderName);
            await fsPromises.mkdir(partFolderPath, { recursive: true });

            const tsChunk = sortedGoodTs.slice(i * MAX_DURATION_SECONDS, (i + 1) * MAX_DURATION_SECONDS);
            const movePromises = tsChunk.map((file) => fsPromises.rename(path.join(sourceFolderPath, file), path.join(partFolderPath, file)));
            await Promise.all(movePromises);
            await generateMetadataAndPlaylist(partFolderPath, partFolderName, tsChunk, originalMetadata);
            logger.info(`Created part ${i + 1} for ${filename} with ${tsChunk.length} segments at ${partFolderPath}`);
        }
    }

    await fsPromises.rm(sourceFolderPath, { recursive: true, force: true });
    logger.info(`Successfully processed and removed original folder: ${filename}`);
}
