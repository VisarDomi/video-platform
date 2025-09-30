// src/repackager.ts
import * as child_process from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import pLimit from 'p-limit';

import * as config from './config.js';
import logger from './logger.js';

// Helper to run a command and get its output/error, with optional real-time logging
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
                // Log stderr lines as they come in for progress. Split by newline or carriage return.
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
        return null; // ffprobe fails on corrupted files, which is expected
    }
};

interface CheckResult {
    status: 'good' | 'bad'; // Simplified status
    path: string;
    reason?: string;
}

const checkSegment = async (filePath: string, targetResolution: string): Promise<CheckResult> => {
    const reasons: string[] = [];
    
    // 1. Check for corruption
    try {
        await runCommand('ffmpeg', ['-nostdin', '-v', 'error', '-i', filePath, '-f', 'null', '-']);
    } catch (error) {
        reasons.push('CORRUPTED');
    }

    // 2. Check resolution
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


export const repackageFolder = async (inputDir: string): Promise<void> => {
    const repackagerConfig = config.getConfig().repackager;

    const inputDirName = path.basename(inputDir);
    // The output directory is simply the parent of the input (segment) directory.
    const outputDir = path.resolve(inputDir, '..'); 
    const outputFile = path.join(outputDir, `${inputDirName}.mp4`);

    logger.info(`[Repackager] Starting process for: ${inputDirName}`);

    try {
        await fs.access(outputFile);
        logger.info(`[Repackager] Output file '${path.basename(outputFile)}' already exists. Skipping actual repackaging.`);
        // Note: The cleanup of the source folder is handled by the calling function.
        return;
    } catch (e) {
        // File doesn't exist, proceed.
    }

    let allDirEntries;
    try {
        allDirEntries = await fs.readdir(inputDir);
    } catch (error) {
        logger.error(`[Repackager] Could not read directory ${path.basename(inputDir)}. It may have been deleted. Skipping.`, { error });
        return;
    }

    const tsFiles = allDirEntries
        .filter(f => f.endsWith('.ts'))
        .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
        .map(f => path.join(inputDir, f));

    if (tsFiles.length === 0) {
        logger.warn(`[Repackager] No .ts files found in non-empty directory ${path.basename(inputDir)}. Skipping repackaging to be safe.`);
        return;
    }

    const targetResolution = repackagerConfig.enforceResolution;
    if (!targetResolution) {
        logger.error(`[Repackager] 'enforceResolution' is not set in config. Aborting for ${inputDirName}.`);
        return;
    }
    logger.info(`[Repackager] Target resolution set to: ${targetResolution}`);

    const limit = pLimit(repackagerConfig.maxWorkers || os.cpus().length);

    logger.info(`[Repackager] Validating ${tsFiles.length} segments...`);
    const checkPromises = tsFiles.map(file => limit(() => checkSegment(file, targetResolution)));
    const checkResults = await Promise.all(checkPromises);
    
    const goodFiles = checkResults.filter(r => r.status === 'good').map(r => r.path);
    const badFiles = checkResults.filter(r => r.status === 'bad');
    
    badFiles.forEach(item => {
        logger.warn(`[Repackager] Skipping segment (${item.reason}): ${path.basename(item.path)}`);
    });

    if (goodFiles.length === 0) {
        logger.warn(`[Repackager] No valid segments found for ${inputDirName}. Skipping MP4 creation.`);
        return;
    }
    
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tango-repacker-'));
    try {
        const fileListPath = path.join(tempDir, 'file_list.txt');
        const fileListContent = goodFiles.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
        await fs.writeFile(fileListPath, fileListContent);

        logger.info(`[Repackager] Validation complete: ${goodFiles.length} good, ${badFiles.length} skipped.`);
        logger.info(`[Repackager] Starting ffmpeg to combine ${goodFiles.length} segments into ${path.basename(outputFile)}...`);

        /**
         * DO NOT REMOVE COMMENT
         * DO NOT CHANGE FORMATTING OF THE COMMAND
         * DO NOT CHANGE THE COMMAND - it is this command that does the magic of playing on safari ios
         */
        await runCommand('ffmpeg', [
            '-nostdin', '-hide_banner', '-loglevel', 'info', '-stats',
            '-f', 'concat',
            '-safe', '0',
            '-i', fileListPath,
            '-c', 'copy',
            '-bsf:a', 'aac_adtstoasc', 
            '-movflags', '+faststart',
            '-fflags', '+genpts',
            '-y',
            outputFile
        ], `Combine: ${inputDirName}`);

        logger.info(`[Repackager] Success! MP4 file created for ${inputDirName}`);

    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
};