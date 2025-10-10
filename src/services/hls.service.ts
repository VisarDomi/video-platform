// src/services/hls.service.ts
import { promises as fs } from "fs";
import path from "path";
import { spawn } from "child_process";
import os from "os";
import pLimit from "p-limit";
import { ALL_VIDEO_PATHS } from "../config.js";
import logger from "../logger.js";

// --- Constants ---
const PLAYLIST_FILENAME = "playlist.m3u8";
const METADATA_FILENAME = "metadata.json";
const SYNC_INTERVAL_MS = 1000 * 60 * 60; // 1 hour

// --- Helper: Get Memory Usage ---
function getMemoryUsage(pid: number): Promise<number | null> {
    return new Promise((resolve) => {
        const ps = spawn("ps", ["-o", "rss=", "-p", String(pid)]);
        let output = "";
        ps.stdout.on("data", (data) => (output += data.toString()));
        ps.on("close", (code) => (code === 0 && output.trim() ? resolve(parseInt(output.trim(), 10)) : resolve(null)));
        ps.on("error", () => resolve(null));
    });
}

// --- Class: PlaylistGenerator ---
// WHY: Encapsulates all logic for processing a single video folder. This cleans up the code significantly.
class PlaylistGenerator {
    private videoFolderPath: string;
    private folderName: string;
    private type: "original" | "edited";
    private memoryReadings: number[] = [];
    private probeLimiter = pLimit(10); // Limit ffprobe concurrency *within* a single video folder task.

    constructor(videoFolderPath: string, folderName: string, type: "original" | "edited") {
        this.videoFolderPath = videoFolderPath;
        this.folderName = folderName;
        this.type = type;
    }

    public async generate(): Promise<void> {
        logger.info(`Starting playlist generation for: ${this.folderName}`);
        try {
            const allFilesOnDisk = await fs.readdir(this.videoFolderPath);
            const tsFiles = allFilesOnDisk.filter((f) => f.endsWith(".ts")).sort((a, b) => parseInt(a) - parseInt(b));
            if (tsFiles.length === 0) {
                logger.warn(`No .ts files found in ${this.folderName}, skipping playlist generation.`);
                return;
            }

            const probeTasks = tsFiles.map((tsFile) =>
                this.probeLimiter(async () => {
                    const resolution = await this.probeSegmentResolution(path.join(this.videoFolderPath, tsFile));
                    return { tsFile, resolution };
                })
            );
            const results = await Promise.all(probeTasks);
            this.logMemoryUsage();

            const newMetadata = { segments: {} as Record<string, { resolution: string }> };
            for (const { tsFile, resolution } of results) {
                newMetadata.segments[tsFile] = { resolution };
            }

            const playlistContent = this.generatePlaylistContent(tsFiles, newMetadata);
            await fs.writeFile(path.join(this.videoFolderPath, METADATA_FILENAME), JSON.stringify(newMetadata, null, 2));
            await fs.writeFile(path.join(this.videoFolderPath, PLAYLIST_FILENAME), playlistContent);

            logger.info(`Successfully generated playlist for: ${this.folderName}`);
        } catch (error) {
            logger.error(`Error during playlist generation for ${this.folderName}`, { error });
        }
    }

    private async probeSegmentResolution(filePath: string): Promise<string> {
        return new Promise((resolve) => {
            const ffprobe = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", filePath]);
            const pid = ffprobe.pid;
            let output = "";
            ffprobe.stdout.on("data", (data) => (output += data.toString()));
            const onEnd = () => (output.trim().split("\n")[0]?.trim() ? resolve(output.trim().split("\n")[0].trim()) : resolve("720x1280"));
            ffprobe.on("close", async () => {
                if (pid) {
                    const memKb = await getMemoryUsage(pid);
                    if (memKb !== null) this.memoryReadings.push(memKb / 1024);
                }
                onEnd();
            });
            ffprobe.on("error", () => resolve("720x1280"));
        });
    }

    // WHY THE FIX: This method now correctly uses the metadata to build the playlist,
    // handling resolution changes and inserting discontinuity tags. This fixes the
    // "value never read" error and restores essential functionality.
    private generatePlaylistContent(segments: string[], metadata: { segments: Record<string, { resolution: string }> }): string {
        let previousResolution = "";
        const segmentLines: string[] = [];
        for (const segment of segments) {
            const meta = metadata.segments[segment];
            if (!meta) continue; // Skip if metadata is missing for some reason
            if (previousResolution && meta.resolution !== previousResolution) {
                segmentLines.push("#EXT-X-DISCONTINUITY");
            }
            segmentLines.push("#EXTINF:1.000,");
            segmentLines.push(`/hls/${this.type}/${this.folderName}/${segment}`);
            previousResolution = meta.resolution;
        }
        return ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:2", ...segmentLines, "#EXT-X-ENDLIST"].join("\n");
    }

    private logMemoryUsage(): void {
        if (this.memoryReadings.length === 0) return;
        const average = this.memoryReadings.reduce((a, b) => a + b, 0) / this.memoryReadings.length;
        logger.info(`ffprobe actual average memory: ${average.toFixed(2)}MB/process ('${this.folderName}')`);
    }
}

// --- Class: HlsService (Singleton) ---
// WHY: Manages the overall process, including a heavily throttled queue for generation tasks.
class HlsService {
    private taskQueue = pLimit(Math.max(1, os.cpus().length / 2));

    public initialize(): void {
        this._scanAndQueueTasks().catch((err) => {
            logger.error("A critical error occurred during the initial HLS scan.", { error: err });
        });
        setInterval(() => this.runHourlySync(), SYNC_INTERVAL_MS);
    }

    private async _scanAndQueueTasks(): Promise<void> {
        logger.info("Starting initial playlist scan and queuing background tasks...");
        await Promise.all(
            ALL_VIDEO_PATHS.map(async ({ path: dirPath, type }) => {
                try {
                    const entries = await fs.readdir(dirPath, { withFileTypes: true });
                    for (const entry of entries) {
                        if (entry.isDirectory()) {
                            const videoFolderPath = path.join(dirPath, entry.name);
                            try {
                                await fs.access(path.join(videoFolderPath, PLAYLIST_FILENAME));
                            } catch {
                                logger.info(`Playlist not found for '${entry.name}'. Queueing generation task.`);
                                const generator = new PlaylistGenerator(videoFolderPath, entry.name, type);
                                void this.taskQueue(() => generator.generate());
                            }
                        }
                    }
                } catch (err) {
                    logger.error(`Failed to scan directory ${dirPath}`, { error: err });
                }
            })
        );
        logger.info("Initial scan complete. Server is ready. Generation tasks are running in the background.");
    }

    private runHourlySync(): void {
        logger.info("Running hourly playlist validation sync...");
        // This can be expanded with more detailed logic later if needed.
    }
}

export const hlsService = new HlsService();
