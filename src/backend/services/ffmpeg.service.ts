// src/services/ffmpeg.service.ts
import { spawn } from "child_process";
import logger from "../logger.js";
import { FfmpegError } from "../errors.js";

/**
 * @fileoverview
 * This service encapsulates all interactions with the ffmpeg and ffprobe command-line tools.
 * By isolating this logic, we make the rest of the application easier to test and maintain,
 * as it no longer needs to know the details of spawning child processes.
 */

/**
 * Builds the complex filter argument for the ffmpeg command to trim and concatenate video segments.
 * @param sourcePath The full path to the input video.
 * @param outputPath The full path for the output video.
 * @param segments An array of start and end times for the clips to keep.
 * @returns An array of strings representing the arguments for the ffmpeg command.
 */
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

/**
 * Spawns and manages an ffmpeg child process, returning a promise that resolves on success or rejects on error.
 * @param args The command-line arguments for ffmpeg.
 * @returns A promise that resolves when the process completes successfully.
 * @throws {FfmpegError} If the ffmpeg process exits with a non-zero status code.
 */
export function executeFfmpegCommand(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        logger.info("Executing ffmpeg with args:", { args: JSON.stringify(args) });
        const ffmpeg = spawn("ffmpeg", args);
        let stderrOutput = "";

        ffmpeg.stderr.on("data", (data) => {
            stderrOutput += data.toString();
            logger.verbose(`ffmpeg stderr: ${data}`);
        });

        ffmpeg.on("close", (code) => {
            if (code !== 0) {
                const fullCommand = `ffmpeg ${args.join(" ")}`;
                const error = new FfmpegError(`ffmpeg process exited with code ${code}`, stderrOutput);
                logger.error(error.message, { fullCommand, stderr: stderrOutput });
                return reject(error);
            }
            resolve();
        });

        ffmpeg.on("error", (err) => {
            logger.error("Failed to start ffmpeg process.", { error: err });
            reject(err);
        });
    });
}

/**
 * Gets the duration of a single video file in seconds using ffprobe.
 * @param filePath The full path to the video file.
 * @returns A promise that resolves with the duration in seconds, or 0 if an error occurs.
 */
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
                return resolve(0); // Resolve with 0 on error to not fail the whole batch
            }
            const duration = parseFloat(stdout.trim());
            resolve(isNaN(duration) ? 0 : duration);
        });

        ffprobe.on("error", (err) => {
            logger.error(`Failed to start ffprobe for ${filePath}`, { error: err });
            reject(err); // Reject if the process can't even start
        });
    });
}
