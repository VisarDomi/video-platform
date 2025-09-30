// src/assembler/assembler.ts
import * as child_process from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import pLimit from 'p-limit';

import * as config from '../config.js';
import logger from '../logger.js';


// --- Low-level FFmpeg Utilities ---

const runCommand = (command: string, args: string[], logPrefix?: string): Promise<{ stdout: string; stderr: string }> => {
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
                    if (line.trim()) logger.verbose(`[${logPrefix}] ${line.trim()}`);
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

const getVideoResolution = async (filePath: string): Promise<string | null> => {
    try {
        const { stdout } = await runCommand('ffprobe', [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height',
            '-of', 'csv=s=x:p=0',
            filePath,
        ]);
        const resolution = stdout.trim().split('\n')[0];
        return resolution || null;
    } catch (error) {
        return null;
    }
};


// --- Segment Validation ---

interface ValidationResult {
    goodFiles: string[];
    badFiles: { path: string; reason: string }[];
}

interface CheckResult {
    status: 'good' | 'bad';
    path: string;
    reason?: string;
}

const checkSegment = async (filePath: string, targetResolution: string): Promise<CheckResult> => {
    const reasons: string[] = [];
    try {
        const { stderr } = await runCommand('ffmpeg', ['-nostdin', '-v', 'error', '-i', filePath, '-f', 'null', '-']);
        if (stderr.trim().length > 0) {
            reasons.push('CORRUPTED');
        }
    } catch (error) {
        reasons.push('CORRUPTED');
    }

    const currentResolution = await getVideoResolution(filePath);
    if (!currentResolution) {
        if (!reasons.includes('CORRUPTED')) {
            reasons.push('RESOLUTION_UNREADABLE');
        }
    } else if (currentResolution !== targetResolution) {
        reasons.push(`RESOLUTION_MISMATCH (${currentResolution})`);
    }

    if (reasons.length > 0) {
        return { status: 'bad', path: filePath, reason: reasons.join(' | ') };
    } else {
        return { status: 'good', path: filePath };
    }
};

async function validateSegments(tsFiles: string[], targetResolution: string, maxWorkers: number): Promise<ValidationResult> {
    logger.info(`[Assembler] Validating ${tsFiles.length} segments with target resolution ${targetResolution}...`);
    const limit = pLimit(maxWorkers);
    const checkPromises = tsFiles.map(file => limit(() => checkSegment(file, targetResolution)));
    const checkResults = await Promise.all(checkPromises);
    const goodFiles: string[] = [];
    const badFiles: { path: string; reason: string }[] = [];
    for (const result of checkResults) {
        if (result.status === 'good') {
            goodFiles.push(result.path);
        } else {
            badFiles.push({ path: result.path, reason: result.reason || 'Unknown reason' });
        }
    }
    badFiles.forEach(item => {
        logger.warn(`[Assembler] Skipping segment (${item.reason}): ${path.basename(item.path)}`);
    });
    logger.info(`[Assembler] Validation complete: ${goodFiles.length} good, ${badFiles.length} skipped.`);
    return { goodFiles, badFiles };
}


// --- File Concatenation ---

async function concatenateSegments(goodFiles: string[], outputFile: string, logPrefix: string): Promise<void> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tango-assembler-'));
    try {
        const fileListPath = path.join(tempDir, 'file_list.txt');
        const fileListContent = goodFiles.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
        await fs.writeFile(fileListPath, fileListContent);

        logger.info(`[Assembler] Starting ffmpeg to combine ${goodFiles.length} segments into ${path.basename(outputFile)}...`);

        /**
         * --- Deep Dive into FFmpeg Flags for Safari/iOS Compatibility ---
         * 
         * As you noted, Safari (especially on iOS) is extremely picky about MP4 files,
         * particularly when dealing with concatenated streams. Standard players like VLC or MPV
         * are far more forgiving. These flags are crucial for creating a universally playable file.
         *
         * The command: ffmpeg -f concat -i file_list.txt -c copy -bsf:a aac_adtstoasc -movflags +faststart -fflags +genpts -y output.mp4
         */
        await runCommand('ffmpeg', [
            '-nostdin', '-hide_banner', '-loglevel', 'info', '-stats',
            // Input Driver
            '-f', 'concat', // Use the concat demuxer, which reads a list of files to concatenate.
            '-safe', '0',   // Allows absolute paths in the file list. Necessary since we use full paths.
            '-i', fileListPath,
            
            // Core Operation
            '-c', 'copy',   // Stream copy. This is VITAL. We are not re-encoding the video or audio.
                            // We are just copying the raw H.264 video and AAC audio from the .ts segments
                            // into a new MP4 container. This is extremely fast and preserves quality.

            // Audio Bitstream Filter for Safari/iOS
            '-bsf:a', 'aac_adtstoasc',
                            // The raw audio in MPEG-TS segments is typically AAC with ADTS headers. These headers
                            // describe the audio frame. The MP4 container format, however, does not use ADTS headers;
                            // it stores this information globally in the 'moov' atom. This bitstream filter
                            // (**A**udio **D**ata **T**ransport **S**tream **to** **A**udio **S**pecific **C**onfig)
                            // strips the per-frame ADTS headers and converts them into the global configuration
                            // that the MP4 container requires. Without this, Safari/iOS will often fail to play the audio.

            // MP4 Container Flags for Safari/iOS Streaming
            '-movflags', '+faststart',
                            // The MP4 container has a metadata section called the 'moov' atom, which contains the
                            // index and information needed to play the file (timescales, durations, etc.). By default,
                            // ffmpeg writes this atom at the END of the file after all video/audio data is written.
                            // For web streaming, a player needs this information FIRST to know how to play the video.
                            // '+faststart' post-processes the file to move the 'moov' atom from the end to the beginning.
                            // This allows the video to start playing immediately as it downloads, which is critical for web players.

            // Timestamp Generation Flags for Concatenated Segments
            '-fflags', '+genpts',
                            // When concatenating raw `.ts` files that may have missing or incorrect timestamps (PTS - Presentation Timestamp),
                            // playback can be jerky or broken. This flag tells ffmpeg to regenerate the timestamps based on the frame
                            // rate and order, creating a smooth, continuous timeline. This is another key fix for Safari, which is
                            // less tolerant of timestamp discontinuities than other players.

            // Output Options
            '-y', // Overwrite output file without asking.
            outputFile
        ], `Assemble: ${logPrefix}`);

        logger.info(`[Assembler] Success! MP4 file created for ${path.basename(outputFile)}`);

    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}


// --- Public API ---

export const assembleSegmentsIntoMp4 = async (inputDir: string): Promise<void> => {
    const { repackager: repackagerConfig } = config.getConfig();
    const inputDirName = path.basename(inputDir);
    const outputDir = path.dirname(inputDir);
    const outputFile = path.join(outputDir, `${inputDirName}.mp4`);

    logger.info(`[Assembler] Starting process for: ${inputDirName}`);

    try {
        await fs.access(outputFile);
        logger.info(`[Assembler] Output file '${path.basename(outputFile)}' already exists. Skipping.`);
        return;
    } catch (e) { /* File doesn't exist, proceed. */ }

    const allDirEntries = await fs.readdir(inputDir).catch(() => []);
    const tsFiles = allDirEntries
        .filter(f => f.endsWith('.ts'))
        .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
        .map(f => path.join(inputDir, f));

    if (tsFiles.length === 0) {
        logger.warn(`[Assembler] No .ts files found in directory ${inputDirName}. Skipping.`);
        return;
    }

    const { enforceResolution, maxWorkers } = repackagerConfig;
    if (!enforceResolution) {
        logger.error(`[Assembler] 'enforceResolution' is not set in config. Aborting for ${inputDirName}.`);
        return;
    }

    const { goodFiles } = await validateSegments(tsFiles, enforceResolution, maxWorkers || os.cpus().length);

    if (goodFiles.length === 0) {
        logger.warn(`[Assembler] No valid segments found for ${inputDirName}. Skipping MP4 creation.`);
        return;
    }

    await concatenateSegments(goodFiles, outputFile, inputDirName);
};