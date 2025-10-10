// src/services/hls.service.ts
import { promises as fs } from "fs";
import path from "path";
import { ALL_VIDEO_PATHS } from "../config.js"; // WHY: Use the new specific paths from config
import logger from "../logger.js";

const PLAYLIST_FILENAME = "playlist.m3u8";
const SYNC_INTERVAL_MS = 1000 * 60 * 60; // 1 hour

function generatePlaylistContent(folderName: string, type: "original" | "edited", segments: string[]): string {
    const segmentLines = segments.map((segment) => {
        const extinf = "#EXTINF:1.000,";
        const url = `/hls/${type}/${folderName}/${segment}`;
        return `${extinf}\n${url}`;
    });

    return ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:2", ...segmentLines, "#EXT-X-ENDLIST"].join("\n");
}

async function processDirectory(dirPath: string, type: "original" | "edited"): Promise<void> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
        if (entry.isDirectory()) {
            const videoFolderPath = path.join(dirPath, entry.name);
            try {
                const files = await fs.readdir(videoFolderPath);
                const tsFiles = files.filter((f) => f.endsWith(".ts")).sort();

                if (tsFiles.length > 0) {
                    const playlistPath = path.join(videoFolderPath, PLAYLIST_FILENAME);
                    const newContent = generatePlaylistContent(entry.name, type, tsFiles);
                    await fs.writeFile(playlistPath, newContent);
                    logger.verbose(`Generated playlist for: ${videoFolderPath}`);
                }
            } catch (error) {
                logger.error(`Failed to process directory ${videoFolderPath}`, { error });
            }
        }
    }
}

async function generateAllPlaylists(): Promise<void> {
    logger.info("Starting playlist generation for all video directories...");
    // WHY: We now map over our specific, configured paths.
    const tasks = ALL_VIDEO_PATHS.map(({ path, type }) => processDirectory(path, type));

    await Promise.all(tasks);
    logger.info("Playlist generation complete.");
}

export async function initializeHlsService(): Promise<void> {
    await generateAllPlaylists();

    setInterval(() => {
        logger.info("Running periodic playlist synchronization...");
        void generateAllPlaylists();
    }, SYNC_INTERVAL_MS);
}
