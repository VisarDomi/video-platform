import { spawn } from "child_process";
import { promises as fsPromises } from "fs";
import path from "path";
import { getProviderPaths } from "../../core/config.js";
import logger from "../../core/logger.js";
import { FileNotFoundError, FfmpegError } from "../../core/errors.js";
import { DESTINATIONS, ALL_VIDEO_PATHS_TYPES } from "../../core/constants.js";
import type { VideoRef } from "../../core/types.js";
import * as moveService from "./move.service.js";

type EditJob = {
    filename: string;
    segments: { start: number; end: number }[];
    provider: string;
};

type JobWorker<T> = (job: T) => Promise<void>;

class JobQueue<T> {
    private queue: T[] = [];
    private isProcessing = false;
    private worker: JobWorker<T>;

    constructor(worker: JobWorker<T>) {
        this.worker = worker;
    }

    public add(job: T): void {
        this.queue.push(job);
        logger.info(`MP4 job added to queue. Current queue size: ${this.queue.length}`);
        void this.process();
    }

    private async process(): Promise<void> {
        if (this.isProcessing) return;
        this.isProcessing = true;
        logger.info(`Starting MP4 queue processing. Jobs to process: ${this.queue.length}`);

        while (this.queue.length > 0) {
            const job = this.queue.shift();
            if (job) {
                try {
                    await this.worker(job);
                } catch (error) {
                    logger.error(`An MP4 job in the queue failed to process:`, { job, error });
                }
            }
        }

        this.isProcessing = false;
        logger.info("MP4 queue processing finished.");
    }
}

export function buildFfmpegArgs(sourcePath: string, outputPath: string, segments: { start: number; end: number }[]): string[] {
    const filterChains: string[] = [];
    segments.forEach((seg, i) => {
        filterChains.push(`[0:v]trim=${seg.start}:${seg.end},setpts=PTS-STARTPTS[v${i}]`);
        filterChains.push(`[0:a]atrim=${seg.start}:${seg.end},asetpts=PTS-STARTPTS[a${i}]`);
    });

    const videoConcatInputs = segments.map((_, i) => `[v${i}]`).join("");
    const audioConcatInputs = segments.map((_, i) => `[a${i}]`).join("");
    filterChains.push(`${videoConcatInputs}concat=n=${segments.length}:v=1:a=0[v]`);
    filterChains.push(`${audioConcatInputs}concat=n=${segments.length}:v=0:a=1[a]`);

    const fullFilterComplex = filterChains.join(";");

    return ["-i", sourcePath, "-filter_complex", fullFilterComplex, "-map", "[v]", "-map", "[a]", "-movflags", "+faststart", "-y", outputPath];
}

export function executeFfmpegCommand(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const systemdArgs = [
            "--scope",
            "--user",
            "-p", "MemoryMax=24G",
            "-p", "CPUWeight=100",
            "ffmpeg",
            ...args,
        ];

        logger.info("Executing ffmpeg via systemd-run with args:", { args: JSON.stringify(systemdArgs) });

        const ffmpegProcess = spawn("systemd-run", systemdArgs);
        let stderrOutput = "";

        ffmpegProcess.stderr.on("data", (data) => {
            stderrOutput += data.toString();
        });

        ffmpegProcess.on("close", (code) => {
            if (code !== 0) {
                const error = new FfmpegError(`ffmpeg process exited with code ${code}`, stderrOutput);
                logger.error(error.message, { stderr: stderrOutput });
                return reject(error);
            }
            resolve();
        });

        ffmpegProcess.on("error", (err) => {
            logger.error("Failed to start systemd-run process.", { error: err });
            reject(err);
        });
    });
}

export function getVideoDuration(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const ffprobe = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath]);

        let stdout = "";
        let stderr = "";

        ffprobe.stdout.on("data", (data) => (stdout += data.toString()));
        ffprobe.stderr.on("data", (data) => (stderr += data.toString()));

        ffprobe.on("close", (code) => {
            if (code !== 0) {
                logger.warn(`ffprobe failed for ${filePath} with code ${code}`, { stderr });
                return resolve(0);
            }
            const duration = parseFloat(stdout.trim());
            resolve(isNaN(duration) ? 0 : duration);
        });

        ffprobe.on("error", (err) => {
            logger.error(`Failed to start ffprobe for ${filePath}`, { error: err });
            reject(err);
        });
    });
}

function resolveMp4Ref(filename: string, provider: string, fullPath: string, baseDir: string): VideoRef {
    const paths = getProviderPaths(provider);
    const type = baseDir === paths.downloader
        ? ALL_VIDEO_PATHS_TYPES.ORIGINAL
        : ALL_VIDEO_PATHS_TYPES.EDITED;
    return { filename, provider, type, dirPath: fullPath };
}

async function findMp4File(filename: string, provider: string): Promise<{ fullPath: string; baseDir: string }> {
    const paths = getProviderPaths(provider);
    const searchDirs = [paths.downloader, paths.edited, paths.converted];

    for (const dir of searchDirs) {
        const fullPath = path.join(dir, filename);
        try {
            await fsPromises.access(fullPath);
            return { fullPath, baseDir: dir };
        } catch {}
    }

    throw new FileNotFoundError(`MP4 file not found: ${filename}`);
}

async function processVideoEdit(job: EditJob) {
    const { filename, segments, provider } = job;
    const paths = getProviderPaths(provider);

    const found = await findMp4File(filename, provider);
    const sourcePath = found.fullPath;

    const finalOutputPath = path.join(paths.edited, filename);
    const tempOutputPath = `${finalOutputPath}.${Date.now()}.tmp`;

    await fsPromises.mkdir(paths.edited, { recursive: true });

    try {
        logger.info(`Processing MP4 job for: ${filename} -> ${tempOutputPath}`, { segments });

        const ffmpegArgs = buildFfmpegArgs(sourcePath, tempOutputPath, segments);
        await executeFfmpegCommand(ffmpegArgs);

        await fsPromises.rename(tempOutputPath, finalOutputPath);
        logger.info(`Successfully created edited MP4 video: ${finalOutputPath}`);

        const ref = resolveMp4Ref(filename, provider, sourcePath, found.baseDir);
        await moveService.moveVideo(ref, DESTINATIONS.TRASH);
    } catch (error) {
        logger.error(`MP4 processing failed for ${filename}. Cleaning up temporary file.`, { error });
        try {
            await fsPromises.unlink(tempOutputPath);
        } catch (cleanupError) {
            logger.warn(`Could not clean up temporary file: ${tempOutputPath}`, { cleanupError });
        }
        throw error;
    }
}

const editQueue = new JobQueue<EditJob>(processVideoEdit);

export function editMp4Video(filename: string, segments: { start: number; end: number }[], provider: string): void {
    editQueue.add({ filename, segments, provider });
}
