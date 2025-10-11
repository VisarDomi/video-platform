// src/services/livestream.service.ts
import { promises as fs } from "fs";
import path from "path";
import * as os from "os";
import { spawn } from "child_process";
import pLimit from "p-limit";
import logger from "../logger.js";

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

// --- Class: LivestreamService (Singleton) ---
class LivestreamService {
    private activeStreams = new Map<string, LiveStreamInfo>();
    private probeLimiter = pLimit(10);

    public startMonitoring(): void {
        setInterval(() => this.processLiveStreams(), BACKGROUND_TASK_INTERVAL_MS);
        logger.info("Live stream monitoring started.");
    }

    private async processLiveStreams(): Promise<void> {
        const liveStatus = await this.readLiveStatus();
        if (!liveStatus) {
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
            // FIX: Guard against null or undefined segmentsDirPath from live-status.json.
            // A stream entry might exist before its directory is created/known.
            if (stream.segmentsDirPath) {
                const folderName = path.basename(stream.segmentsDirPath);
                currentLiveStreams.set(folderName, stream);
            } else {
                logger.warn("Skipping a stream from live-status.json because its segmentsDirPath is null.", { streamAlias: stream.alias });
            }
        }

        const previouslyActiveFolders = new Set(this.activeStreams.keys());

        for (const folderName of previouslyActiveFolders) {
            if (!currentLiveStreams.has(folderName)) {
                const streamInfo = this.activeStreams.get(folderName)!;
                logger.info(`Stream ended: ${streamInfo.alias}. Finalizing playlist.`);
                await this.finalizeStream(streamInfo.segmentsDirPath);
                this.activeStreams.delete(folderName);
            }
        }

        // Add new streams that were not previously tracked and update existing ones.
        for (const [folderName, streamInfo] of currentLiveStreams.entries()) {
            this.activeStreams.set(folderName, streamInfo);
        }

        const updatePromises = Array.from(this.activeStreams.values()).map((streamInfo) => this.updateStream(streamInfo));
        await Promise.all(updatePromises);
    }

    public async readLiveStatus(): Promise<LiveStatus | null> {
        try {
            // Use the XDG Base Directory Specification for user-specific data files.
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

export const livestreamService = new LivestreamService();
