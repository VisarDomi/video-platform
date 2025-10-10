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

// This is a helper function, it remains the same.
function probeSegmentResolution(filePath: string): Promise<string> {
    return new Promise((resolve) => {
        const ffprobe = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", filePath]);
        let output = "";
        ffprobe.stdout.on("data", (data) => (output += data.toString()));
        const onEnd = () => {
            if (!output.trim()) {
                logger.warn(`ffprobe failed for ${filePath}. Defaulting resolution.`);
                resolve("360x640");
            } else {
                resolve(output.trim());
            }
        };
        ffprobe.on("close", onEnd);
        ffprobe.on("error", () => {
            logger.error(`Failed to start ffprobe for ${filePath}. Defaulting resolution.`);
            resolve("360x640");
        });
    });
}

// This is also a helper, it remains the same.
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

/**
 * The "brute-force" workhorse function. It probes ALL .ts files in a folder,
 * creates fresh metadata, and generates a new playlist.
 */
async function forceGeneratePlaylistForDirectory(videoFolderPath: string, folderName: string, type: "original" | "edited"): Promise<void> {
    logger.info(`Performing full generation for: ${folderName}`);
    try {
        const allFilesOnDisk = await fs.readdir(videoFolderPath);
        const tsFiles = allFilesOnDisk.filter((f) => f.endsWith(".ts")).sort();
        if (tsFiles.length === 0) return;

        const metadataPath = path.join(videoFolderPath, METADATA_FILENAME);
        const playlistPath = path.join(videoFolderPath, PLAYLIST_FILENAME);
        const newMetadata: MetadataCache = { segments: {} };

        // Probe all files in parallel. This is the expensive, one-time operation.
        const probeTasks = tsFiles.map(async (tsFile) => {
            const resolution = await probeSegmentResolution(path.join(videoFolderPath, tsFile));
            return { tsFile, resolution };
        });
        const results = await Promise.all(probeTasks);

        // Populate the new metadata object
        for (const { tsFile, resolution } of results) {
            newMetadata.segments[tsFile] = { resolution };
        }

        // Write both the new metadata and the new playlist to disk.
        await fs.writeFile(metadataPath, JSON.stringify(newMetadata, null, 2));
        const playlistContent = generatePlaylistContent(folderName, type, tsFiles, newMetadata);
        await fs.writeFile(playlistPath, playlistContent);

        logger.info(`Successfully regenerated playlist for: ${folderName}`);
    } catch (error) {
        logger.error(`Error during full generation for ${folderName}`, { error });
    }
}

/**
 * The function for the hourly check. It validates playlists against file counts.
 */
async function validateAndSyncPlaylists(): Promise<void> {
    logger.info("Running hourly playlist validation...");
    for (const { path: dirPath, type } of ALL_VIDEO_PATHS) {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;

            const videoFolderPath = path.join(dirPath, entry.name);
            try {
                const tsFiles = (await fs.readdir(videoFolderPath)).filter((f) => f.endsWith(".ts"));
                const playlistPath = path.join(videoFolderPath, PLAYLIST_FILENAME);

                const playlistContent = await fs.readFile(playlistPath, "utf-8");
                const playlistEntryCount = (playlistContent.match(/#EXTINF/g) || []).length;

                // The core validation logic: compare counts.
                if (tsFiles.length !== playlistEntryCount) {
                    logger.warn(
                        `Stale playlist detected in ${entry.name}. Mismatch: ${tsFiles.length} files vs ${playlistEntryCount} entries. Regenerating...`
                    );
                    await forceGeneratePlaylistForDirectory(videoFolderPath, entry.name, type);
                }
            } catch {
                // This can happen if a folder has .ts files but no playlist yet.
                // The startup logic handles this, but we can trigger it here too for robustness.
                logger.info(`Playlist missing or unreadable for ${entry.name}. Attempting to generate.`);
                await forceGeneratePlaylistForDirectory(videoFolderPath, entry.name, type);
            }
        }
    }
    logger.info("Hourly playlist validation complete.");
}

/**
 * The main exported function that orchestrates the startup and background sync.
 */
export async function initializeHlsService(): Promise<void> {
    logger.info("Starting initial playlist scan...");
    // --- ON APP STARTUP LOGIC ---
    for (const { path: dirPath, type } of ALL_VIDEO_PATHS) {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;

            const videoFolderPath = path.join(dirPath, entry.name);
            const playlistPath = path.join(videoFolderPath, PLAYLIST_FILENAME);
            try {
                // Check if a playlist already exists.
                await fs.access(playlistPath);
            } catch {
                // If it doesn't exist, run the full generation process.
                logger.info(`Playlist not found for ${entry.name}. Generating now.`);
                await forceGeneratePlaylistForDirectory(videoFolderPath, entry.name, type);
            }
        }
    }
    logger.info("Initial playlist scan complete.");

    // --- PERIODIC SYNC LOGIC ---
    setInterval(() => {
        void validateAndSyncPlaylists();
    }, SYNC_INTERVAL_MS);
}
