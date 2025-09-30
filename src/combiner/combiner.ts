// src/combiner/combiner.ts
import * as child_process from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import pLimit from "p-limit";
import logger from "../logger.js";
import * as storage from "../storage.js";
import * as fileTracker from "../fileTracker.js";

const MIN_DURATION_SECONDS = 15 * 60; // 15 minutes

interface VideoInfo {
    filePath: string;
    duration: number; // in seconds
    username: string;
    timestamp: string; // YYYY-MM-DD HHMMSS part
}

const runCommand = (command: string, args: string[], logPrefix?: string): Promise<{ stdout: string; stderr:string }> => {
    return new Promise((resolve, reject) => {
        const process = child_process.spawn(command, args);
        let stdout = '';
        let stderr = '';
        process.stdout.on('data', (data) => (stdout += data.toString()));
        process.stderr.on('data', (data) => {
            const chunk = data.toString();
            stderr += chunk;
            if (logPrefix) {
                chunk.trim().split(/[\r\n]+/).forEach((line: string) => {
                    if (line.trim()) logger.info(`[${logPrefix}] ${line.trim()}`);
                });
            }
        });
        process.on('close', (code) => {
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                reject(new Error(`Command "${command} ${args.join(' ')}" failed with code ${code}:\n${stderr}`));
            }
        });
        process.on('error', (err) => {
            reject(new Error(`Failed to start command "${command}": ${err.message}`));
        });
    });
};

async function getVideoDuration(filePath: string): Promise<number> {
    try {
        const { stdout } = await runCommand('ffprobe', [
            '-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1', filePath
        ]);
        return parseFloat(stdout);
    } catch (error) {
        logger.error(`[Combiner] Failed to get duration for ${path.basename(filePath)}`, { error });
        return 0;
    }
}

function parseFileName(fileName: string): { username: string, timestamp: string } | null {
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
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tango-combiner-'));
    const fileListPath = path.join(tempDir, 'filelist.txt');

    try {
        const fileListContent = videoBatch.map(v => `file '${v.filePath.replace(/'/g, "'\\''")}'`).join('\n');
        await fs.writeFile(fileListPath, fileListContent);
        logger.info(`[Combiner] Stitching ${videoBatch.length} videos into ${outputFileName}...`);

        await runCommand('ffmpeg', [
            '-nostdin', '-hide_banner', '-loglevel', 'info', '-stats',
            '-f', 'concat', '-safe', '0', '-i', fileListPath,
            '-c', 'copy', '-y', outputFile
        ], `Stitch: ${firstVideo.username}`);

        logger.info(`[Combiner] Successfully created stitched video: ${outputFile}`);
        return outputFile;
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

export async function combineShortVideos(unprocessedFiles: string[], baseDir: string): Promise<void> {
    if (unprocessedFiles.length === 0) {
        logger.verbose("[Combiner] No new video files to process.");
        return;
    }

    const limit = pLimit(os.cpus().length);
    logger.info(`[Combiner] Analyzing ${unprocessedFiles.length} files...`);

    const promises = unprocessedFiles.map((file) => 
        limit(async (): Promise<VideoInfo | null> => {
            const fullPath = path.join(baseDir, file);
            const metadata = parseFileName(file);
            if (!metadata) {
                logger.warn(`[Combiner] Could not parse filename: ${file}. Skipping.`);
                return null;
            }
            const duration = await getVideoDuration(fullPath);
            return { filePath: fullPath, duration, ...metadata };
        })
    );

    const videoInfos: VideoInfo[] = (await Promise.all(promises))
        .filter((v): v is VideoInfo => v !== null && v.duration > 0);
    
    logger.info(`[Combiner] Finished analyzing ${videoInfos.length} valid video files.`);

    const videosByUser = new Map<string, VideoInfo[]>();
    for (const video of videoInfos) {
        if (!videosByUser.has(video.username)) videosByUser.set(video.username, []);
        videosByUser.get(video.username)!.push(video);
    }
    
    let allSourceFilesToTrash: string[] = [];
    let allSourceFileNamesToTrack: string[] = [];

    for (const [username, userVideos] of videosByUser.entries()) {
        logger.info(`[Combiner] Processing ${userVideos.length} videos for user: ${username}`);
        userVideos.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        
        let remainingVideos = [...userVideos];
        while (remainingVideos.length > 0) {
            let batch: VideoInfo[] = [];
            let batchDuration = 0;
            let processedCount = 0;
            for (const video of remainingVideos) {
                batch.push(video);
                batchDuration += video.duration;
                processedCount++;
                if (batchDuration >= MIN_DURATION_SECONDS) break;
            }

            if (batch.length > 1 && batchDuration >= MIN_DURATION_SECONDS) {
                logger.info(`[Combiner] Formed a batch of ${batch.length} for ${username} (${Math.round(batchDuration / 60)} mins).`);
                await stitchVideos(batch, baseDir);

                const sourceFiles = batch.map(v => v.filePath);
                allSourceFilesToTrash.push(...sourceFiles);
                allSourceFileNamesToTrack.push(...sourceFiles.map(f => path.basename(f)));
                
                remainingVideos.splice(0, processedCount);
            } else {
                logger.info(`[Combiner] Not enough videos for ${username} to meet threshold. ${remainingVideos.length} videos remain.`);
                allSourceFileNamesToTrack.push(...remainingVideos.map(v => v.filePath).map(f => path.basename(f)));
                break;
            }
        }
    }

    for (const filePath of allSourceFilesToTrash) {
        await storage.moveToTrash(filePath);
    }
    await fileTracker.saveProcessedFiles(allSourceFileNamesToTrack);
}