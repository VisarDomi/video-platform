import { Router } from 'express';
import { promises as fsp } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { VIDEO_ROOT_DIRS } from './config.js';
import { findVideoPath } from './utils.js';
import logger from './logger.js';

const router = Router();

// --- Helper Functions ---

/**
 * Moves a file to a 'trash' subdirectory within its base directory.
 * This is a safer alternative to permanent deletion.
 */
async function moveFileToTrash(filePath: string, baseDir: string) {
    const trashDir = path.join(baseDir, 'trash');
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
    return []; // Return empty array on error to avoid crashing the whole endpoint
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
        '-y', // Overwrite output file if it exists
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
                const error = new Error(`ffmpeg process exited with code ${code}`);
                logger.error(error.message, { fullCommand: `ffmpeg ${args.join(' ')}`, stderr: stderrOutput });
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


// --- API Endpoints ---

/**
 * GET /api/videos
 * Retrieves a list of all original and edited videos from all configured directories.
 */
router.get('/videos', async (req, res) => {
  try {
    const allFilesPromises = VIDEO_ROOT_DIRS.flatMap(dir => [
      getVideosFromDir(dir, 'original'),
      getVideosFromDir(path.join(dir, 'edited'), 'edited')
    ]);
    
    const fileArrays = await Promise.all(allFilesPromises);
    const allFiles = fileArrays.flat().sort((a, b) => a.filename.localeCompare(b.filename));

    res.json(allFiles);
  } catch (error: any) {
    logger.error(`Error listing video directories:`, { error });
    res.status(500).json({ error: 'Could not list video directories.' });
  }
});

/**
 * DELETE /api/videos/:type/:filename
 * Moves a specified video file to a 'trash' directory instead of deleting it.
 */
router.delete('/videos/:type/:filename', async (req, res) => {
    const { type, filename } = req.params as { type: 'original' | 'edited', filename: string };

    if (!filename || (type !== 'original' && type !== 'edited')) {
        return res.status(400).json({ success: false, message: 'Invalid request parameters.' });
    }
    
    const foundVideo = await findVideoPath(type, filename);
    if (!foundVideo) {
        return res.status(404).json({ success: false, message: 'Video file not found.' });
    }

    try {
        await moveFileToTrash(foundVideo.fullPath, foundVideo.baseDir);
        res.json({ success: true, message: 'Video moved to trash successfully.' });
    } catch (err) {
        logger.error('Error moving file to trash:', { file: foundVideo.fullPath, err });
        res.status(500).json({ success: false, message: 'Failed to move video to trash.' });
    }
});


/**
 * POST /api/edit
 * Creates a new, edited video from segments of an original video.
 * The new video is placed in an 'edited' subfolder, and the original is moved to 'trash'.
 */
router.post('/edit', async (req, res) => {
    const { filename, segments }: { filename: string, segments: {start: number, end: number}[] } = req.body;

    if (!filename || !segments || segments.length === 0) {
        return res.status(400).json({ success: false, message: 'Invalid request: filename and segments are required.' });
    }

    const foundVideo = await findVideoPath('original', filename);
    if (!foundVideo) {
        return res.status(404).json({ success: false, message: 'Original video file not found.' });
    }

    const { fullPath: sourcePath, baseDir } = foundVideo;
    const editedVideosDir = path.join(baseDir, 'edited');
    const outputPath = path.join(editedVideosDir, filename);

    try {
        await fsp.mkdir(editedVideosDir, { recursive: true });

        const ffmpegArgs = buildFfmpegArgs(sourcePath, outputPath, segments);
        await executeFfmpegCommand(ffmpegArgs);

        logger.info(`Successfully created edited video: ${outputPath}`);

        // Auto-move original file to trash on success
        await moveFileToTrash(sourcePath, baseDir);

        res.json({ success: true, message: 'Created edited video and moved original to trash.' });

    } catch (error) {
        logger.error(`Failed to process video ${filename}:`, { error });
        res.status(500).json({ success: false, message: 'Failed to process video.' });
    }
});

export default router;