// src/combiner/combiner.ts
import * as childProcess from "child_process";
import * as fsPromises from "fs/promises";
import * as path from "path";
import * as os from "os";

import logger from "../common/logger.js";
import * as config from "../common/config.js";
import * as storage from "../common/storage.js";

const getMinDurationSeconds = (): number => config.getConfig().combiner.minDurationMinutes * 60;

interface VideoInfo {
    filePath: string;
    duration: number; // in seconds
    username: string;
    timestamp: string; // YYYY-MM-DD HHMMSS part
}

/**
 * Reads all .mp4 files from the specified directory.
 */
async function getLocalVideoFiles(directory: string): Promise<string[]> {
    try {
        const allFiles = await fsPromises.readdir(directory);
        return allFiles.filter((file) => file.toLowerCase().endsWith(".mp4"));
    } catch (error: any) {
        if (error.code === "ENOENT") {
            logger.warn(`[Combiner] Directory not found, returning no files: ${directory}`);
            return [];
        }
        throw error;
    }
}

const runCommand = (command: string, args: string[], logPrefix?: string): Promise<{ stdout: string; stderr:string }> => {
    return new Promise((resolve, reject) => {
        const process = childProcess.spawn(command, args);
        let stdout = "";
        let stderr = "";
        process.stdout.on("data", (data) => (stdout += data.toString()));
        process.stderr.on("data", (data) => {
            const chunk = data.toString();
            stderr += chunk;
            if (logPrefix) {
                chunk
                    .trim()
                    .split(/[\r\n]+/)
                    .forEach((line: string) => {
                        if (line.trim()) logger.info(`[${logPrefix}] ${line.trim()}`);
                    });
            }
        });
        process.on("close", (code) => {
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                reject(new Error(`Command "${command} ${args.join(" ")}" failed with code ${code}:\n${stderr}`));
            }
        });
        process.on("error", (err) => {
            reject(new Error(`Failed to start command "${command}": ${err.message}`));
        });
    });
};

async function getVideoDuration(filePath: string): Promise<number> {
    try {
        const { stdout } = await runCommand("ffprobe", [
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            filePath,
        ]);
        return parseFloat(stdout);
    } catch (error) {
        logger.error(`[Combiner] Failed to get duration for ${path.basename(filePath)}`, { error });
        return 0;
    }
}

function parseFileName(fileName: string): { username: string; timestamp: string } | null {
    const match = fileName.match(/^(\d{4}-\d{2}-\d{2} \d{6}) (.+?)( \d+min)?\.mp4$/);
    if (match && match[1] && match[2]) {
        return { timestamp: match[1], username: match[2].trim() };
    }
    return null;
}

/**
 * Converts an MP4 file to a temporary MPEG-TS file without re-encoding.
 * This is a necessary intermediate step for reliable concatenation.
 */
async function convertToIntermediateTs(mp4Path: string, tempDir: string): Promise<string> {
    const tsName = `${path.parse(mp4Path).name}.ts`;
    const tsPath = path.join(tempDir, tsName);
    await runCommand("ffmpeg", [
        "-i",
        mp4Path,
        "-c",
        "copy", // Do not re-encode
        "-bsf:v",
        "h264_mp4toannexb", // Bitstream filter to make the video stream compatible with MPEG-TS
        "-f",
        "mpegts", // Output format
        tsPath,
    ]);
    return tsPath;
}

async function stitchVideos(videoBatch: VideoInfo[], outputDir: string): Promise<string> {
    if (videoBatch.length === 0) throw new Error("Cannot stitch an empty batch of videos.");

    const firstVideo = videoBatch[0];
    const totalDuration = Math.round(videoBatch.reduce((sum, v) => sum + v.duration, 0) / 60);
    const outputFileName = `${firstVideo.timestamp} ${firstVideo.username} ${totalDuration}min.mp4`;
    const outputFile = path.join(outputDir, outputFileName);
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "tango-combiner-"));
    const fileListPath = path.join(tempDir, "filelist.txt");

    try {
        // Step 1: Convert all MP4s in the batch to intermediate .ts files
        const intermediateTsFiles: string[] = [];
        for (const video of videoBatch) {
            const tsPath = await convertToIntermediateTs(video.filePath, tempDir);
            intermediateTsFiles.push(tsPath);
        }

        // Step 2: Create a file list of the *new .ts files*
        const fileListContent = intermediateTsFiles.map((tsPath) => `file '${tsPath.replace(/'/g, "'\\''")}'`).join("\n");
        await fsPromises.writeFile(fileListPath, fileListContent);
        logger.info(`[Combiner] Stitching ${videoBatch.length} videos into ${outputFileName}...`);

        // Step 3: Concatenate the .ts files and package them back into an MP4 container
        await runCommand(
            "ffmpeg",
            [
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "info",
                "-stats",
                "-f",
                "concat", // Use the concat demuxer on our list of .ts files
                "-safe",
                "0",
                "-i",
                fileListPath,
                "-c",
                "copy", // Copy the streams without re-encoding
                "-bsf:a",
                "aac_adtstoasc", // This filter is crucial for audio compatibility in the final MP4
                "-movflags",
                "+faststart",
                "-fflags",
                "+genpts",
                "-y",
                outputFile,
            ],
            `Stitch: ${firstVideo.username}`
        );

        logger.info(`[Combiner] Successfully created stitched video: ${outputFile}`);
        return outputFile;
    } finally {
        await fsPromises.rm(tempDir, { recursive: true, force: true });
    }
}

/**
 * Scans the 'edited' directory for videos, finds the first possible batch of short videos
 * from the same streamer that meets the minimum duration, combines them, and then returns.
 * @param baseDir The directory to scan for videos (e.g., '.../edited').
 * @returns {Promise<boolean>} A promise that resolves to `true` if a combination occurred, `false` otherwise.
 */
export async function combineShortVideos(baseDir: string): Promise<boolean> {
    const minDurationSeconds = getMinDurationSeconds();

    // 1. Get the current list of files in the directory.
    const filesInDir = (await getLocalVideoFiles(baseDir)).sort(); // Sort chronologically to process in order.

    if (filesInDir.length < 2) {
        logger.verbose("[Combiner] Not enough files to form a batch. Skipping cycle.");
        return false;
    }

    // 2. Sequentially scan for a "starting file" (a short video).
    for (let i = 0; i < filesInDir.length; i++) {
        const startFileName = filesInDir[i];
        const startFullPath = path.join(baseDir, startFileName);
        const startMetadata = parseFileName(startFileName);

        if (!startMetadata) continue;

        const startDuration = await getVideoDuration(startFullPath);

        // Found a potential starting point? (duration is valid and less than the threshold)
        if (startDuration > 0 && startDuration < minDurationSeconds) {
            logger.info(`[Combiner] Found potential starting file: ${startFileName} (${Math.round(startDuration)}s) for user ${startMetadata.username}.`);

            // 3. This is our starting file. Initialize a batch with it.
            const batch: VideoInfo[] = [
                {
                    filePath: startFullPath,
                    duration: startDuration,
                    username: startMetadata.username,
                    timestamp: startMetadata.timestamp,
                },
            ];
            let batchDuration = startDuration;
            const currentStreamer = startMetadata.username;

            // 4. Scan forward from this point to find more files from the same user.
            for (let j = i + 1; j < filesInDir.length; j++) {
                const nextFileName = filesInDir[j];
                const nextMetadata = parseFileName(nextFileName);

                // Is this file from the same streamer?
                if (nextMetadata && nextMetadata.username === currentStreamer) {
                    const nextFullPath = path.join(baseDir, nextFileName);
                    const nextDuration = await getVideoDuration(nextFullPath);

                    if (nextDuration > 0) {
                        batch.push({
                            filePath: nextFullPath,
                            duration: nextDuration,
                            username: nextMetadata.username,
                            timestamp: nextMetadata.timestamp,
                        });
                        batchDuration += nextDuration;
                        logger.verbose(`[Combiner] Added ${nextFileName} to batch for ${currentStreamer}. New total duration: ${Math.round(batchDuration)}s`);

                        // 5. Have we met the duration threshold?
                        if (batchDuration >= minDurationSeconds) {
                            logger.info(`[Combiner] Batch for ${currentStreamer} met duration threshold (${Math.round(batchDuration / 60)} mins). Combining ${batch.length} files.`);

                            // Combine the videos.
                            await stitchVideos(batch, baseDir);

                            // On success, move source files to trash.
                            for (const videoInfo of batch) {
                                await storage.moveToTrash(videoInfo.filePath);
                            }

                            return true; // Signal that a combination happened so the service can re-scan.
                        }
                    }
                }
            }
            // If the inner loop finishes, it means we scanned all subsequent files but couldn't meet the threshold for this starting file.
            // The outer loop will continue to the next file, trying it as a new starting point.
            logger.info(`[Combiner] Scanned all subsequent files for start file ${startFileName}, but threshold not met. Looking for a new starting file.`);
        }
    }

    // 6. If we get through the whole loop, no combinations were possible in this pass.
    logger.info("[Combiner] Full scan of files complete. No new batches were formed.");
    return false;
}