// src/services/video.service.ts
import { promises as fsp } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { VIDEO_ROOT_DIRS } from '../config.js';
import { findVideoPath } from '../utils.js';
import logger from '../logger.js';
import { FileNotFoundError, FfmpegError } from '../errors.js';

// --- Video Editing Queue ---
const editQueue: { filename: string, segments: {start: number, end: number}[] }[] = [];
let isProcessingQueue = false;


// --- Internal Helper Functions ---

/**
 * Moves a file to a 'trash_edit' subdirectory within its base directory.
 * This is used to avoid conflicts with other applications that may use a 'trash' folder.
 */
async function moveFileToTrash(filePath: string, baseDir: string) {
    const trashDir = path.join(baseDir, 'trash_edit');
    await fsp.mkdir(trashDir, { recursive: true });
    
    const filename = path.basename(filePath);
    const destinationPath = path.join(trashDir, filename);
    
    await fsp.rename(filePath, destinationPath);
    logger.info(`Moved file to trash: ${destinationPath}`);
}

/**
 * Reads a directory and returns a list of video file objects.
 */
async function getVideosFromDir(dirPath: string, type: 'original' | 'edited') {
  try {
    await fsp.mkdir(dirPath, { recursive: true });
    const files = await fsp.readdir(dirPath);
    return files
      .filter(file => path.extname(file).toLowerCase() === ".mp4")
      .map(filename => ({ filename, type }));
  } catch (error) {
    logger.error(`Could not read directory: ${dirPath}`, { error });
    return []; // Return empty array on error
  }
}

/**
 * Builds the complex filter argument for the ffmpeg command.
 */
function buildFfmpegArgs(sourcePath: string, outputPath: string, segments: { start: number; end: number }[]): string[] {
    const filterChains: string[] = [];
    segments.forEach((seg, i) => {
        filterChains.push(`[0:v]trim=${seg.start}:${seg.end},setpts=PTS-STARTPTS[v${i}]`);
        filterChains.push(`[0:a]atrim=${seg.start}:${seg.end},asetpts=PTS-STARTPTS[a${i}]`);
    });

    const videoConcatInputs = segments.map((_, i) => `[v${i}]`).join('');
    const audioConcatInputs = segments.map((_, i) => `[a${i}]`).join('');
    filterChains.push(`${videoConcatInputs}concat=n=${segments.length}:v=1:a=0[v]`);
    filterChains.push(`${audioConcatInputs}concat=n=${segments.length}:v=0:a=1[a]`);
    
    const fullFilterComplex = filterChains.join(';');

    return [
        '-i', sourcePath,
        '-filter_complex', fullFilterComplex,
        '-map', '[v]',
        '-map', '[a]',
        '-movflags', '+faststart',
        '-y',
        outputPath
    ];
}

/**
 * Spawns and manages the ffmpeg child process.
 */
function executeFfmpegCommand(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        logger.info('Executing ffmpeg with args:', { args: JSON.stringify(args) });
        const ffmpeg = spawn('ffmpeg', args);
        let stderrOutput = '';

        ffmpeg.stderr.on('data', (data) => {
            stderrOutput += data.toString();
            logger.verbose(`ffmpeg stderr: ${data}`);
        });

        ffmpeg.on('close', (code) => {
            if (code !== 0) {
                const fullCommand = `ffmpeg ${args.join(' ')}`;
                const error = new FfmpegError(`ffmpeg process exited with code ${code}`, stderrOutput);
                logger.error(error.message, { fullCommand, stderr: stderrOutput });
                return reject(error);
            }
            resolve();
        });

        ffmpeg.on('error', (err) => {
            logger.error('Failed to start ffmpeg process.', { error: err });
            reject(err);
        });
    });
}

/**
 * The core logic for processing a single video edit job.
 */
async function _processVideoEdit(filename: string, segments: {start: number, end: number}[]) {
    const foundVideo = await findVideoPath('original', filename);
    if (!foundVideo) {
        throw new FileNotFoundError(`Original video file not found: ${filename}`);
    }

    const { fullPath: sourcePath, baseDir } = foundVideo;
    const editedVideosDir = path.join(baseDir, 'edited');
    const outputPath = path.join(editedVideosDir, filename);

    await fsp.mkdir(editedVideosDir, { recursive: true });

    const ffmpegArgs = buildFfmpegArgs(sourcePath, outputPath, segments);
    await executeFfmpegCommand(ffmpegArgs);

    logger.info(`Successfully created edited video: ${outputPath}`);

    // Auto-move original file to trash on success
    await moveFileToTrash(sourcePath, baseDir);
}

/**
 * Processes the edit queue one job at a time.
 */
async function processEditQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;
    logger.info(`Starting edit queue processing. Jobs in queue: ${editQueue.length}`);

    while (editQueue.length > 0) {
        const job = editQueue.shift();
        if (job) {
            try {
                logger.info(`Processing job for: ${job.filename}`, { segments: job.segments });
                await _processVideoEdit(job.filename, job.segments);
            } catch (error) {
                // Log the error but continue processing the rest of the queue
                logger.error(`Failed to process job for ${job.filename}:`, { error });
            }
        }
    }

    isProcessingQueue = false;
    logger.info('Edit queue processing finished.');
}


// --- Exported Service Functions ---

export async function getAllVideos() {
    const allFilesPromises = VIDEO_ROOT_DIRS.flatMap(dir => [
      getVideosFromDir(dir, 'original'),
      getVideosFromDir(path.join(dir, 'edited'), 'edited')
    ]);
    
    const fileArrays = await Promise.all(allFilesPromises);
    return fileArrays.flat().sort((a, b) => a.filename.localeCompare(b.filename));
}

export async function trashVideo(type: 'original' | 'edited', filename: string) {
    const foundVideo = await findVideoPath(type, filename);
    if (!foundVideo) {
        throw new FileNotFoundError(`Video file not found: ${filename}`);
    }
    await moveFileToTrash(foundVideo.fullPath, foundVideo.baseDir);
}

export function createEditedVideo(filename: string, segments: {start: number, end: number}[]) {
    editQueue.push({ filename, segments });
    logger.info(`Added video to edit queue: ${filename}. Queue size: ${editQueue.length}`);
    
    // Asynchronously process the queue without blocking the API response.
    // The 'void' operator indicates we are intentionally not awaiting the promise.
    void processEditQueue();
}

export async function moveVideoToEdited(type: 'original', filename: string) {
    if (type !== 'original') {
        throw new Error('Only original videos can be moved to the edited folder.');
    }
    
    const foundVideo = await findVideoPath(type, filename);
    if (!foundVideo) {
        throw new FileNotFoundError(`Video file not found: ${filename}`);
    }

    const { fullPath: sourcePath, baseDir } = foundVideo;
    const editedVideosDir = path.join(baseDir, 'edited');
    const destinationPath = path.join(editedVideosDir, filename);
    
    await fsp.mkdir(editedVideosDir, { recursive: true });
    await fsp.rename(sourcePath, destinationPath);
    logger.info(`Moved video to edited folder: ${destinationPath}`);
}

/**
 * Gets the duration of a single video file using ffprobe.
 */
function getVideoDuration(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const ffprobe = spawn('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ]);

        let stdout = '';
        let stderr = '';

        ffprobe.stdout.on('data', (data) => stdout += data.toString());
        ffprobe.stderr.on('data', (data) => stderr += data.toString());

        ffprobe.on('close', (code) => {
            if (code !== 0) {
                logger.warn(`ffprobe failed for ${filePath} with code ${code}`, { stderr });
                return resolve(0); // Resolve with 0 on error to not fail the whole batch
            }
            const duration = parseFloat(stdout.trim());
            resolve(isNaN(duration) ? 0 : duration);
        });
        
        ffprobe.on('error', (err) => {
             logger.error(`Failed to start ffprobe for ${filePath}`, { error: err });
             reject(err); // Reject if the process can't even start
        });
    });
}

/**
 * Gets durations for all video files.
 */
export async function getAllVideoDurations(): Promise<Record<string, number>> {
    const allVideos = await getAllVideos();
    const durationPromises = allVideos.map(async (video) => {
        const foundVideo = await findVideoPath(video.type, video.filename);
        if (!foundVideo) {
            return { filename: video.filename, duration: 0 };
        }
        const duration = await getVideoDuration(foundVideo.fullPath);
        return { filename: video.filename, duration };
    });

    const results = await Promise.all(durationPromises);

    // Convert array of objects to a single { filename: duration } object
    return results.reduce((acc, { filename, duration }) => {
        acc[filename] = duration;
        return acc;
    }, {} as Record<string, number>);
}