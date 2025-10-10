// src/services/vod.service.ts
import { promises as fs } from "fs";
import path from "path";
import { spawn } from "child_process";
import pLimit from "p-limit";
import { ALL_VIDEO_PATHS } from "../config.js";
import logger from "../logger.js";
import { performance } from "perf_hooks";
import { livestreamService } from "./livestream.service.js";

const PLAYLIST_FILENAME = "playlist.m3u8";
const METADATA_FILENAME = "metadata.json";

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

// --- Class: PlaylistGenerator (For VOD generation) ---
class PlaylistGenerator {
    private videoFolderPath: string;
    private folderName: string;
    private type: "original" | "edited";
    private memoryReadings: number[] = [];
    private probeLimiter = pLimit(10);
    constructor(videoFolderPath: string, folderName: string, type: "original" | "edited") {
        this.videoFolderPath = videoFolderPath;
        this.folderName = folderName;
        this.type = type;
    }

    public async generate(): Promise<void> {
        // CONTINUOUS POLLING: Check for live status at the last possible moment.
        const liveStatus = await livestreamService.readLiveStatus();
        const liveFolders = new Set(liveStatus?.downloads.map((d) => path.basename(d.segmentsDirPath)) ?? []);
        if (liveFolders.has(this.folderName)) {
            logger.info(`Skipping VOD generation for '${this.folderName}' because it is currently live.`);
            return; // Abort this task. The livestreamService is handling it.
        }

        const startTime = performance.now();
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

            const playlistContent = this.generateVodPlaylistContent(tsFiles, newMetadata);
            await fs.writeFile(path.join(this.videoFolderPath, METADATA_FILENAME), JSON.stringify(newMetadata, null, 2));
            await fs.writeFile(path.join(this.videoFolderPath, PLAYLIST_FILENAME), playlistContent);

            const endTime = performance.now();
            const durationSeconds = ((endTime - startTime) / 1000).toFixed(2);
            logger.info(`Successfully generated playlist for: ${this.folderName} in ${durationSeconds}s`);
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

    private generateVodPlaylistContent(segments: string[], metadata: { segments: Record<string, { resolution: string }> }): string {
        let previousResolution = "";
        const segmentLines: string[] = [];
        for (const segment of segments) {
            const meta = metadata.segments[segment];
            if (!meta) continue;
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

// --- Class: VodService (Singleton) ---
class VodService {
    private vodGenerationQueue = pLimit(1);

    public async processBacklog(): Promise<void> {
        logger.info("Starting initial scan for VODs needing playlists...");
        const tasksToQueue: { folderName: string; videoFolderPath: string; type: "original" | "edited" }[] = [];

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
                                // Queue any folder that's missing a playlist.
                                // The live-check will happen inside the queued task.
                                tasksToQueue.push({ folderName: entry.name, videoFolderPath, type });
                            }
                        }
                    }
                } catch (err) {
                    logger.error(`Failed to scan directory ${dirPath} for VODs`, { error: err });
                }
            })
        );

        tasksToQueue.sort((a, b) => a.folderName.localeCompare(b.folderName));

        for (const task of tasksToQueue) {
            logger.info(`VOD playlist not found for '${task.folderName}'. Queueing generation task.`);
            const generator = new PlaylistGenerator(task.videoFolderPath, task.folderName, task.type);
            void this.vodGenerationQueue(() => generator.generate());
        }

        logger.info(`VOD scan complete. ${tasksToQueue.length} generation tasks queued.`);
    }
}

export const vodService = new VodService();
