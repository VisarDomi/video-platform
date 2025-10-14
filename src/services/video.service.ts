// src/services/video.service.ts
import { promises as fsPromises } from "fs";
import path from "path";
import { VIDEO_DOWNLOAD_PATH, VIDEO_CONVERT_PATH, VIDEO_MODIFIED_PATH, VIDEO_TRASH_PATH } from "../config.js";
import logger from "../logger.js";
import * as utils from "../utils.js";
import * as types from "../types.js";
import * as errors from "../errors.js";

async function getVideosFromDir(dirPath: string, type: "original" | "edited"): Promise<types.VideoItem[]> {
    const videoItems: types.VideoItem[] = [];
    try {
        await fsPromises.mkdir(dirPath, { recursive: true });
        const entries = await fsPromises.readdir(dirPath, { withFileTypes: true, recursive: false });

        await Promise.all(
            entries.map(async (entry) => {
                if (entry.isDirectory()) {
                    const videoFolderPath = path.join(dirPath, entry.name);
                    const playlistPath = path.join(videoFolderPath, "playlist.m3u8");
                    try {
                        await fsPromises.access(playlistPath);
                        videoItems.push({ filename: entry.name, type, size: 0, duration: 0 });
                    } catch (err) {
                        // Skip folders without a playlist, they can't be played by the frontend's hls.js
                    }
                }
            })
        );
    } catch (error) {
        logger.error(`Could not read directory: ${dirPath}`, { error });
    }
    return videoItems;
}

export async function getAllVideos(): Promise<types.VideoItem[]> {
    const downloadPromise = getVideosFromDir(VIDEO_DOWNLOAD_PATH, "original");
    const convertPromise = getVideosFromDir(VIDEO_CONVERT_PATH, "edited");
    const modifiedPromise = getVideosFromDir(VIDEO_MODIFIED_PATH, "edited");
    const [downloadVideos, convertVideos, modifiedVideos] = await Promise.all([downloadPromise, convertPromise, modifiedPromise]);
    return [...downloadVideos, ...convertVideos, ...modifiedVideos].sort((a, b) => a.filename.localeCompare(b.filename));
}

export async function getVideosDetails(videos: types.VideoItem[]): Promise<types.VideoItem[]> {
    const detailPromises = videos.map(async (video) => {
        try {
            const videoPath = await utils.findVideoPath(video.filename);
            if (!videoPath) return null;

            //TODO: the video-cacher calculates and caches every detail except for live. for live we always calculate on the fly.
            // caching is done using ffprobe or ffmpeg to get the necessary data, like duration
            // to cache: each segment length - delete all those with bitrate bigger than 20MB - those are broken - add discontinuities to the playlist
            const temp = `visar@z440:~/Videos/tango/download/2025-10-03 011231 queensara5$ ffprobe -i 8.ts 
            Input #0, mpegts, from '8.ts':
            Duration: 00:00:01.06, start: 753.331000, bitrate: 2271 kb/s
            Program 1 
            Stream #0:0[0x100]: Video: h264 (Main) ([27][0][0][0] / 0x001B), yuv420p(progressive), 720x1280, 30 tbr, 90k tbn
            Stream #0:1[0x101]: Audio: aac (LC) ([15][0][0][0] / 0x000F), 44100 Hz, mono, fltp, 66 kb/s
            `

            const duration = 0;
            const size = 0;
            return {
                filename: video.filename,
                type: video.type,
                size,
                duration,
            };
        } catch (error) {
            logger.warn(`Could not get details for ${video.filename}`, { error });
            return null;
        }
    });
    const results = await Promise.all(detailPromises);
    return results.filter((result): result is types.VideoItem => result !== null);
}

export async function moveVideo(filename: string, destination: "trash" | "original"): Promise<void> {
    let newPath: string;
    if (destination !== "trash" && destination !== "original") {
        throw new errors.MoveError("destination can only have the values trash or original");
    } else {
        if (destination === "trash") {
            newPath = VIDEO_TRASH_PATH;
        } else {
            newPath = VIDEO_DOWNLOAD_PATH;
        }
    }
    const videoPath = await utils.findVideoPath(filename);
    if (!videoPath) throw new errors.FileNotFoundError(`Video folder not found: ${filename}`);
    if (!videoPath.includes(newPath)) {
        const destinationPath = path.join(newPath, filename);
        await fsPromises.rename(videoPath, destinationPath);
        logger.info(`Moved folder to: ${destinationPath}`);
    } else {
        throw new errors.MoveError("File is already at the destination.");
    }
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
        const parts: string[][] = await getParts(filename, sortedGoodTs); // the duration has been cached by video-cacher, we use that to split

        for (let i = 0; i < parts.length; i++) {
            const tsChunk = parts[i];
            const partFolderName = parts.length > 1 ? `${filename} part${i + 1}` : filename;
            const destinationPath = path.join(VIDEO_CONVERT_PATH, partFolderName);
            await fsPromises.mkdir(destinationPath, { recursive: true });
            const movePromises = tsChunk.map((file) => fsPromises.rename(path.join(filename, file), path.join(destinationPath, file)));
            await Promise.all(movePromises);
            await createPlaylist(filename, tsChunk, destinationPath);
            logger.info(`Created part ${i + 1} for ${filename} with ${tsChunk.length} segments at ${destinationPath}`);
        }
    }

    await moveVideo(filename, "trash");
    logger.info(`Successfully processed and removed original folder: ${filename}`);
}

async function getParts(filename: string, tsFiles: string[]) {
    const durations: Map<string, number> = await getDurations(filename);
    let totalDuration = 0;
    const parts: string[][] = [];
    let tsChunk: string[] = [];
    for (const tsFile of tsFiles) {
        let tsDuration;
        if (durations.has(tsFile)) {
            tsDuration = durations.get(tsFile);
        } else {
            tsDuration = await getDuration(path.join(filename, tsFile));
        }
        tsChunk.push(tsFile);
        totalDuration += tsDuration!; // TODO: remove !. why does typescript not pickup durations.has(tsFile)
        if (totalDuration > 30 * 60) {
            parts.push(Array.from(tsChunk)) // TODO: there should be a better way than this hack
            tsChunk = [];
            totalDuration = 0;
        }
    }
    return parts;
}

async function getDurations(filename: string) {
    // get the duration of each tsFile from cache
    // read file... parse file + create data structure... seen this one before -> should refactor

    // ok, but what should the interface look like?
    // fullTsPath -> duration?



    const durations = new Map<string, number>();




    return durations;
}

async function getDuration(tsFilename: string) {
    // get the duration of a tsFile from cache
    // we get here only if the tsFile is not already cached... should not happen
    // read file... parse file + create data structure... seen this one before -> should refactor
    const duration = 0;
    return duration;
}

async function createPlaylist(filename: string, tsChunk: string[], destinationPath: string) {
    // copies the original playlist in memory, modifies it to add discontinuations, then places it at the destination
    // read file... parse file + create data structure... seen this one before -> should refactor

    // copying things is not a good habbit
    const videoPath = await utils.findVideoPath(filename); 
    const playlistPath = path.join(videoPath, "playlist.m3u8");
    const playlistContent = await fsPromises.readFile(playlistPath, "utf-8");
    
    const lines = playlistContent.split('\n')

    const temp = `
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA-SEQUENCE:93
#EXT-X-TARGETDURATION:4
#EXT-X-DISCONTINUITY
#EXT-X-PROGRAM-DATE-TIME:2025-10-14T21:56:41.400Z
#EXTINF:4.060,
93.ts
#EXT-X-PROGRAM-DATE-TIME:2025-10-14T21:56:45.460Z
#EXTINF:0.200,
94.ts
#EXT-X-PROGRAM-DATE-TIME:2025-10-14T21:56:45.660Z
#EXTINF:1.960,
95.ts
#EXT-X-PROGRAM-DATE-TIME:2025-10-14T21:56:47.620Z
#EXTINF:2.040,
96.ts
#EXT-X-PROGRAM-DATE-TIME:2025-10-14T21:56:49.660Z
#EXTINF:2.020,
97.ts
#EXT-X-PROGRAM-DATE-TIME:2025-10-14T21:56:51.680Z
#EXTINF:2.000,
98.ts
#EXT-X-PROGRAM-DATE-TIME:2025-10-14T21:56:53.680Z
#EXTINF:1.480,
99.ts
#EXT-X-PROGRAM-DATE-TIME:2025-10-14T21:56:55.160Z
#EXTINF:2.101,
100.ts
#EXT-X-PROGRAM-DATE-TIME:2025-10-14T21:56:57.261Z
#EXTINF:2.099,
101.ts
`

    const tsFiles = new Set(tsChunk); // let's say it's a set of 96.ts and 97.ts
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]; // let's say we are at line 95.ts... what happens?
        // we do some wizardry and modify the playlist like a surgeon
        // TODO: how to implement
    }
}
