// src/services/hls.service.ts
import { promises as fs } from "fs";
import path from "path";
import * as os from "os";
import { spawn } from "child_process";
import pLimit from "p-limit";
import { ALL_VIDEO_PATHS } from "../config.js";
import logger from "../logger.js";
import { performance } from "perf_hooks";

// --- Type Definitions ---
interface LiveStreamInfo {
    masterPlaylistUrl: string;
    streamerId: string;
    alias: string;
    liveUrl: string;
    segmentsDirPath: string;
}

interface LiveStatus {
    downloads: LiveStreamInfo[];
    lastUpdated: string;
}

interface SegmentMetadata {
    resolution: string;
}

interface StreamMetadata {
    segments: Record<string, SegmentMetadata>;
}

// --- Constants ---
const PLAYLIST_FILENAME = "playlist.m3u8";
const METADATA_FILENAME = "metadata.json";
const LIVE_STATUS_FILENAME = "live-status.json";
const BACKGROUND_TASK_INTERVAL_MS = 1000;
const ENDLIST_TAG = "#EXT-X-ENDLIST";

// --- Helper: Get Memory Usage (for VOD PlaylistGenerator) ---
function getMemoryUsage(pid: number): Promise<number | null> {
    return new Promise((resolve) => {
        const ps = spawn("ps", ["-o", "rss=", "-p", String(pid)]);
        let output = "";
        ps.stdout.on("data", (data) => (output += data.toString()));
        ps.on("close", (code) => (code === 0 && output.trim() ? resolve(parseInt(output.trim(), 10)) : resolve(null)));
        ps.on("error", () => resolve(null));
    });
}

// --- Class: PlaylistGenerator (For initial VOD generation) ---
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

// --- Class: HlsService (Singleton) ---
class HlsService {
    private vodGenerationQueue = pLimit(1);
    private activeStreams = new Map<string, LiveStreamInfo>();
    private probeLimiter = pLimit(10);

    public initialize(): void {
        // Fire-and-forget the startup sequence so the server can start immediately.
        this._runStartupSequence().catch((err) => {
            logger.error("HLS startup sequence failed to launch.", { error: err });
        });
    }

    private async _runStartupSequence(): Promise<void> {
        await this.recoverInterruptedStreams();
        await this._initialScanForVODs();

        // Now that the initial VOD backlog is queued, start monitoring for live streams.
        setInterval(() => this.processLiveStreams(), BACKGROUND_TASK_INTERVAL_MS);
        logger.info("HLS service initialized. Live stream monitoring started.");
    }

    private async _initialScanForVODs(): Promise<void> {
        logger.info("Starting initial scan for VODs needing playlists...");

        const liveStatus = await this.readLiveStatus();
        const liveFolders = new Set(liveStatus?.downloads.map((d) => path.basename(d.segmentsDirPath)) ?? []);

        const tasksToQueue: { folderName: string; videoFolderPath: string; type: "original" | "edited" }[] = [];
        await Promise.all(
            ALL_VIDEO_PATHS.map(async ({ path: dirPath, type }) => {
                try {
                    const entries = await fs.readdir(dirPath, { withFileTypes: true });
                    for (const entry of entries) {
                        if (entry.isDirectory() && !liveFolders.has(entry.name)) {
                            const videoFolderPath = path.join(dirPath, entry.name);
                            try {
                                await fs.access(path.join(videoFolderPath, PLAYLIST_FILENAME));
                            } catch {
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

    private async recoverInterruptedStreams(): Promise<void> {
        logger.info("Starting recovery scan for interrupted streams...");
        let recoveryCount = 0;

        for (const { path: dirPath } of ALL_VIDEO_PATHS) {
            try {
                const entries = await fs.readdir(dirPath, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        const videoFolderPath = path.join(dirPath, entry.name);
                        const playlistPath = path.join(videoFolderPath, PLAYLIST_FILENAME);
                        try {
                            const content = await fs.readFile(playlistPath, "utf-8");
                            if (!content.trim().endsWith(ENDLIST_TAG)) {
                                await fs.appendFile(playlistPath, `\n${ENDLIST_TAG}\n`);
                                logger.info(`Recovered interrupted stream: ${entry.name}`);
                                recoveryCount++;
                            }
                        } catch (err: any) {
                            if (err.code !== "ENOENT") {
                                logger.warn(`Could not process playlist for recovery in ${entry.name}`, { error: err });
                            }
                        }
                    }
                }
            } catch (err) {
                logger.error(`Failed to scan directory for recovery: ${dirPath}`, { error: err });
            }
        }
        logger.info(`Recovery scan complete. Finalized ${recoveryCount} streams.`);
    }

    private async processLiveStreams(): Promise<void> {
        const liveStatus = await this.readLiveStatus();
        if (!liveStatus) {
            // If live-status is gone, assume all streams ended and finalize them
            if (this.activeStreams.size > 0) {
                logger.info("live-status.json not found, finalizing all tracked active streams.");
                const finalizePromises = Array.from(this.activeStreams.values()).map((stream) => this.finalizeStream(stream.segmentsDirPath));
                await Promise.all(finalizePromises);
                this.activeStreams.clear();
            }
            return;
        }

        const currentLiveStreams = new Map<string, LiveStreamInfo>();
        for (const stream of liveStatus.downloads) {
            const folderName = path.basename(stream.segmentsDirPath);
            currentLiveStreams.set(folderName, stream);
        }

        const previouslyActiveFolders = new Set(this.activeStreams.keys());
        const currentlyActiveFolders = new Set(currentLiveStreams.keys());

        for (const folderName of previouslyActiveFolders) {
            if (!currentlyActiveFolders.has(folderName)) {
                const streamInfo = this.activeStreams.get(folderName)!;
                logger.info(`Stream ended: ${streamInfo.alias}. Finalizing playlist.`);
                await this.finalizeStream(streamInfo.segmentsDirPath);
            }
        }

        const updatePromises = Array.from(currentLiveStreams.values()).map((streamInfo) => this.updateStream(streamInfo));
        await Promise.all(updatePromises);

        this.activeStreams = currentLiveStreams;
    }

    private async readLiveStatus(): Promise<LiveStatus | null> {
        try {
            // Use the XDG Base Directory Specification for user-specific data files.
            // This is the standard "Linux way" for services running under a specific user.
            const sharedStatePath = path.join(os.homedir(), ".local", "share", "tango-services");
            const statusFilePath = path.join(sharedStatePath, LIVE_STATUS_FILENAME);
            const content = await fs.readFile(statusFilePath, "utf-8");
            return JSON.parse(content) as LiveStatus;
        } catch (error: any) {
            if (error.code !== "ENOENT") {
                logger.error("Failed to read or parse live-status.json", { error });
            }
            return null;
        }
    }

    private async updateStream(streamInfo: LiveStreamInfo): Promise<void> {
        try {
            const { segmentsDirPath } = streamInfo;
            await fs.mkdir(segmentsDirPath, { recursive: true });

            const metadataPath = path.join(segmentsDirPath, METADATA_FILENAME);
            const playlistPath = path.join(segmentsDirPath, PLAYLIST_FILENAME);

            const metadata = await this.readMetadata(metadataPath);
            const existingSegments = new Set(Object.keys(metadata.segments));

            const allFiles = await fs.readdir(segmentsDirPath);
            const tsFilesOnDisk = allFiles.filter((f) => f.endsWith(".ts"));
            const newTsFiles = tsFilesOnDisk.filter((f) => !existingSegments.has(f));

            if (newTsFiles.length === 0) return;

            const probeTasks = newTsFiles.map((tsFile) =>
                this.probeLimiter(async () => {
                    const fullPath = path.join(segmentsDirPath, tsFile);
                    const resolution = await this.probeLiveSegmentResolution(fullPath);
                    return { tsFile, resolution };
                })
            );
            const probedSegments = await Promise.all(probeTasks);

            for (const { tsFile, resolution } of probedSegments) {
                metadata.segments[tsFile] = { resolution };
            }
            await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

            const sortedSegments = Object.keys(metadata.segments).sort((a, b) => parseInt(a) - parseInt(b));
            const playlistContent = this.generateLivePlaylistContent(sortedSegments, metadata, streamInfo);
            await fs.writeFile(playlistPath, playlistContent);
        } catch (error) {
            logger.error(`Error updating stream for ${streamInfo.alias}`, { error });
        }
    }

    private async readMetadata(filePath: string): Promise<StreamMetadata> {
        try {
            const content = await fs.readFile(filePath, "utf-8");
            return JSON.parse(content) as StreamMetadata;
        } catch {
            return { segments: {} };
        }
    }

    private async probeLiveSegmentResolution(filePath: string): Promise<string> {
        return new Promise((resolve) => {
            const ffprobe = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", filePath]);
            let output = "";
            ffprobe.stdout.on("data", (data) => (output += data.toString()));
            ffprobe.on("close", () => {
                const resolution = output.trim().split("\n")[0]?.trim();
                resolve(resolution || "720x1280");
            });
            ffprobe.on("error", (err) => {
                logger.warn(`ffprobe failed for ${filePath}, using default resolution.`, { error: err });
                resolve("720x1280");
            });
        });
    }

    private generateLivePlaylistContent(segments: string[], metadata: StreamMetadata, streamInfo: LiveStreamInfo): string {
        const folderName = path.basename(streamInfo.segmentsDirPath);
        let previousResolution = "";
        const segmentLines: string[] = [];

        for (const segment of segments) {
            const meta = metadata.segments[segment];
            if (!meta) continue;
            if (previousResolution && meta.resolution !== previousResolution) {
                segmentLines.push("#EXT-X-DISCONTINUITY");
            }
            segmentLines.push("#EXTINF:1.000,");
            segmentLines.push(`/hls/original/${folderName}/${segment}`);
            previousResolution = meta.resolution;
        }

        return ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:2", ...segmentLines].join("\n");
    }

    private async finalizeStream(folderPath: string): Promise<void> {
        const playlistPath = path.join(folderPath, PLAYLIST_FILENAME);
        try {
            const content = await fs.readFile(playlistPath, "utf-8");
            if (!content.trim().endsWith(ENDLIST_TAG)) {
                await fs.appendFile(playlistPath, `\n${ENDLIST_TAG}\n`);
            }
        } catch (error) {
            logger.error(`Failed to finalize playlist for ${path.basename(folderPath)}`, { error });
        }
    }
}

export const hlsService = new HlsService();
