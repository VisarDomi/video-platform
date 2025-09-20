// src/repackager.ts
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import pLimit from 'p-limit';
import { getConfig } from './config.js';
import logger from './logger.js';

// Helper to run a command and get its output/error, with optional real-time logging
const runCommand = (command: string, args: string[], logPrefix?: string): Promise<{ stdout: string; stderr: string }> => {
    return new Promise((resolve, reject) => {
        const process = spawn(command, args);
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
    status: 'good' | 'repair';
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
        return { status: 'repair', path: filePath, reason: reasons.join(' | ') };
    } else {
        return { status: 'good', path: filePath };
    }
};

const repairSegment = async (sourcePath: string, destPath: string, targetResolution: string): Promise<boolean> => {
    const { repairPreset, repairCrf } = getConfig().repackager;
    const [targetWidth, targetHeight] = targetResolution.split('x');
    const sourceName = path.basename(sourcePath);
    const parentDirName = path.basename(path.dirname(sourcePath));

    try {
        logger.info(`[Repackager] Starting repair for segment: ${sourcePath}`);
        /**
         * DO NOT REMOVE COMMENT
         * DO NOT CHANGE FORMATTING OF THE COMMAND
         * DO NOT CHANGE THE COMMAND - it is this command that does the magic of playing on safari ios
         */
        await runCommand('ffmpeg', [
            '-nostdin', '-hide_banner', '-loglevel', 'info', '-stats', '-y',
            '-i', sourcePath,
            '-vf', `scale=${targetWidth}:${targetHeight},format=yuv420p`,
            '-c:v', 'libx264', '-preset', repairPreset, '-crf', repairCrf,
            '-c:a', 'copy',
            destPath,
        ], `Repair: ${parentDirName}/${sourceName}`);
        logger.info(`[Repackager] Successfully repaired segment: ${sourcePath}`);
        return true;
    } catch (error: any) {
        logger.error(`Failed to repair ${sourcePath}`, { error: error.message });
        return false;
    }
};

export const repackageFolder = async (inputDir: string): Promise<void> => {
    const config = getConfig();
    const repackagerConfig = config.repackager;

    const inputDirName = path.basename(inputDir);
    // The output directory is simply the parent of the input (segment) directory.
    const outputDir = path.resolve(inputDir, '..'); 
    const outputFile = path.join(outputDir, `${inputDirName}.mp4`);

    logger.info(`[Repackager] Starting process for: ${inputDirName}`);

    try {
        await fs.access(outputFile);
        logger.info(`[Repackager] Output file '${path.basename(outputFile)}' already exists. Skipping.`);
        if (repackagerConfig.deleteRawOnSuccess) {
            logger.info(`[Repackager] Deleting raw segment folder: ${inputDirName}`);
            await fs.rm(inputDir, { recursive: true, force: true });
        }
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

    // 1. If the directory is completely empty, it's safe to clean up.
    if (allDirEntries.length === 0) {
        logger.warn(`[Repackager] Directory ${path.basename(inputDir)} is empty. Cleaning it up.`);
        await fs.rm(inputDir, { recursive: true, force: true });
        return;
    }

    // 2. If not empty, find the .ts files.
    const tsFiles = allDirEntries
        .filter(f => f.endsWith('.ts'))
        .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
        .map(f => path.join(inputDir, f));

    // 3. If the folder is not empty but contains no .ts files, it's an anomaly.
    //    Log it and leave it alone for manual inspection. DO NOT DELETE.
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
    const repairQueue = checkResults.filter(r => r.status === 'repair');
    
    repairQueue.forEach(item => {
        logger.warn(`[Repackager] Needs repair (${item.reason}): ${item.path}`);
    });

    const repairedFilesMap = new Map<string, string>();
    const repairDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tango-repacker-'));
    
    try {
        if (repairQueue.length > 0) {
            logger.info(`[Repackager] Repairing ${repairQueue.length} segment(s)...`);
            const repairPromises = repairQueue.map(item => limit(async () => {
                const sourcePath = item.path;
                const destPath = path.join(repairDir, path.basename(sourcePath));
                const success = await repairSegment(sourcePath, destPath, targetResolution);
                if (success) {
                    repairedFilesMap.set(sourcePath, destPath);
                }
            }));
            await Promise.all(repairPromises);
        }

        const fileListPath = path.join(repairDir, 'file_list.txt');
        const finalFilePaths: string[] = [];

        for (const f of tsFiles) {
            if (repairedFilesMap.has(f)) {
                finalFilePaths.push(repairedFilesMap.get(f)!);
            } else if (goodFiles.includes(f)) {
                finalFilePaths.push(f);
            }
        }
        
        if (finalFilePaths.length === 0) {
            throw new Error('No valid segments left to process after repair attempts.');
        }

        const fileListContent = finalFilePaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
        await fs.writeFile(fileListPath, fileListContent);

        logger.info(`[Repackager] Validation complete: ${goodFiles.length} good, ${repairedFilesMap.size} repaired, ${repairQueue.length - repairedFilesMap.size} failed.`);
        logger.info(`[Repackager] Starting ffmpeg to combine ${finalFilePaths.length} segments into ${path.basename(outputFile)}...`);

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

        if (repackagerConfig.deleteRawOnSuccess) {
            logger.info(`[Repackager] Deleting raw segment folder: ${inputDirName}`);
            await fs.rm(inputDir, { recursive: true, force: true });
        }

    } finally {
        await fs.rm(repairDir, { recursive: true, force: true });
    }
};