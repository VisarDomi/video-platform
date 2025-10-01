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

const runCommand = (command: string, args: string[], logPrefix?: string): Promise<{ stdout: string; stderr: string }> => {
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


/*
The Regex Breakdown
^(\d{4}-\d{2}-\d{2} \d{6}) (.+?)( \d+min)?\.mp4$
^ : Asserts the start of the string.
(\d{4}-\d{2}-\d{2} \d{6}) : Capture Group 1 (Timestamp). Matches and captures YYYY-MM-DD HHMMSS.
  : A literal space character.
(.+?) : Capture Group 2 (Username). This is the key part.
. : Matches any character.
+ : Matches the previous character one or more times.
? : This is the non-greedy/lazy modifier. It tells the + to match as few characters as possible while still allowing the rest of the regex to find a match.
( \d+min)? : Capture Group 3 (Optional Duration).
  : A literal space.
\d+ : One or more digits.
min : The literal text "min".
? : The ? at the end makes this entire group optional. It can appear zero or one time.
\.mp4$ : Matches the literal text .mp4 at the very end of the string.
*/
function parseFileName(fileName: string): { username: string; timestamp: string } | null {
    const match = fileName.match(/^(\d{4}-\d{2}-\d{2} \d{6}) (.+?)( \d+min)?\.mp4$/);
    if (match && match[1] && match[2]) {
        return { timestamp: match[1], username: match[2].trim() };
    }
    return null;
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
        const fileListContent = videoBatch.map((v) => `file '${v.filePath.replace(/'/g, "'\\''")}'`).join("\n");
        await fsPromises.writeFile(fileListPath, fileListContent);
        logger.info(`[Combiner] Stitching ${videoBatch.length} videos into ${outputFileName}...`);

        await runCommand(
            "ffmpeg",
            [
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "info",
                "-stats",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                fileListPath,
                "-c",
                "copy",
                "-fflags",
                "+genpts",
                "-movflags",
                "+faststart",
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