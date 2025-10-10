// src/services/hls.service.ts
import { promises as fs } from "fs";
import path from "path";
import { spawn } from "child_process";
import { ALL_VIDEO_PATHS } from "../config.js";
import logger from "../logger.js";

const PLAYLIST_FILENAME = "playlist.m3u8";
const METADATA_FILENAME = "metadata.json";
const SYNC_INTERVAL_MS = 1000 * 60 * 60; // 1 hour

type SegmentMetadata = { resolution: string };
type MetadataCache = { segments: Record<string, SegmentMetadata> };

function probeSegmentResolution(filePath: string): Promise<string> {
    return new Promise((resolve) => {
        const ffprobe = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", filePath]);
        let output = "";
        ffprobe.stdout.on("data", (data) => (output += data.toString()));
        const onEnd = () => {
            // WHY THE FIX: The output sometimes contains multiple lines or extra newlines.
            // We split by newline and take the first valid entry to ensure a clean "720x1280" string.
            const resolution = output.trim().split("\n")[0]?.trim();
            if (!resolution) {
                logger.warn(`ffprobe failed for ${filePath}. Defaulting resolution.`);
                resolve("720x1280");
            } else {
                resolve(resolution);
            }
        };
        ffprobe.on("close", onEnd);
        ffprobe.on("error", () => {
            logger.error(`Failed to start ffprobe for ${filePath}. Defaulting resolution.`);
            resolve("720x1280");
        });
    });
}

function generatePlaylistContent(folderName: string, type: "original" | "edited", segments: string[], metadata: MetadataCache): string {
    let previousResolution = "";
    const segmentLines: string[] = [];
    for (const segment of segments) {
        const meta = metadata.segments[segment];
        if (!meta) continue;
        if (previousResolution && meta.resolution !== previousResolution) {
            segmentLines.push("#EXT-X-DISCONTINUITY");
        }
        segmentLines.push("#EXTINF:1.000,");
        segmentLines.push(`/hls/${type}/${folderName}/${segment}`);
        previousResolution = meta.resolution;
    }
    return ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:2", ...segmentLines, "#EXT-X-ENDLIST"].join("\n");
}

async function forceGeneratePlaylistForDirectory(videoFolderPath: string, folderName: string, type: "original" | "edited"): Promise<void> {
    logger.info(`Performing full generation for: ${folderName}`);
    try {
        const allFilesOnDisk = await fs.readdir(videoFolderPath);
        const tsFiles = allFilesOnDisk.filter((f) => f.endsWith(".ts")).sort((a, b) => parseInt(a) - parseInt(b));

        if (tsFiles.length === 0) return;

        const metadataPath = path.join(videoFolderPath, METADATA_FILENAME);
        const playlistPath = path.join(videoFolderPath, PLAYLIST_FILENAME);
        const newMetadata: MetadataCache = { segments: {} };

        const probeTasks = tsFiles.map(async (tsFile) => {
            const resolution = await probeSegmentResolution(path.join(videoFolderPath, tsFile));
            return { tsFile, resolution };
        });
        const results = await Promise.all(probeTasks);

        for (const { tsFile, resolution } of results) {
            newMetadata.segments[tsFile] = { resolution };
        }

        await fs.writeFile(metadataPath, JSON.stringify(newMetadata, null, 2));
        const playlistContent = generatePlaylistContent(folderName, type, tsFiles, newMetadata);
        await fs.writeFile(playlistPath, playlistContent);

        logger.info(`Successfully regenerated playlist for: ${folderName}`);
    } catch (error) {
        logger.error(`Error during full generation for ${folderName}`, { error });
    }
}

async function validateAndSyncPlaylists(): Promise<void> {
    logger.info("Running hourly playlist validation...");
    for (const { path: dirPath, type } of ALL_VIDEO_PATHS) {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;

            const videoFolderPath = path.join(dirPath, entry.name);
            try {
                const tsFileCountOnDisk = (await fs.readdir(videoFolderPath)).filter((f) => f.endsWith(".ts")).length;
                const playlistPath = path.join(videoFolderPath, PLAYLIST_FILENAME);

                const playlistContent = await fs.readFile(playlistPath, "utf-8");
                const playlistEntryCount = (playlistContent.match(/#EXTINF/g) || []).length;

                if (tsFileCountOnDisk !== playlistEntryCount) {
                    logger.warn(
                        `Stale playlist detected in ${entry.name}. Mismatch: ${tsFileCountOnDisk} files vs ${playlistEntryCount} entries. Regenerating...`
                    );
                    await forceGeneratePlaylistForDirectory(videoFolderPath, entry.name, type);
                }
            } catch {
                logger.info(`Playlist missing or unreadable for ${entry.name}. Attempting to generate.`);
                await forceGeneratePlaylistForDirectory(videoFolderPath, entry.name, type);
            }
        }
    }
    logger.info("Hourly playlist validation complete.");
}

export async function initializeHlsService(): Promise<void> {
    logger.info("Starting initial playlist scan...");
    for (const { path: dirPath, type } of ALL_VIDEO_PATHS) {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;

            const videoFolderPath = path.join(dirPath, entry.name);
            const playlistPath = path.join(videoFolderPath, PLAYLIST_FILENAME);
            try {
                await fs.access(playlistPath);
            } catch {
                logger.info(`Playlist not found for ${entry.name}. Generating now.`);
                await forceGeneratePlaylistForDirectory(videoFolderPath, entry.name, type);
            }
        }
    }
    logger.info("Initial playlist scan complete.");

    setInterval(() => {
        void validateAndSyncPlaylists();
    }, SYNC_INTERVAL_MS);
}
