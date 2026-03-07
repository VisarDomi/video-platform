import { promises as fsPromises } from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import pLimit from "p-limit";
import logger from "./logger.js";
import { FILE_EXTENSIONS, FILE_NAMES, FFMPEG, HLS, MISC } from "./constants.js";
import { fixTargetDuration } from "shared";

const execFileAsync = promisify(execFile);
const limit = pLimit(5); // Process 5 segments at a time

function extractSegmentNumber(filename: string): number | null {
    const match = filename.match(/(\d+)\.ts$/);
    return match ? parseInt(match[1], 10) : null;
}

export async function getSegmentDuration(tsFilePath: string): Promise<number> {
    try {
        const { stdout } = await execFileAsync(FFMPEG.COMMAND, [
            FFMPEG.ARGS.QUIET,
            FFMPEG.ARGS.QUIET_LEVEL,
            FFMPEG.ARGS.PRINT_FORMAT,
            FFMPEG.ARGS.FORMAT_JSON,
            FFMPEG.ARGS.SHOW_FORMAT,
            tsFilePath,
        ]);
        const data = JSON.parse(stdout);
        const duration = parseFloat(data.format.duration);
        return isNaN(duration) ? 0 : duration;
    } catch (error) {
        logger.warn(`Failed to probe ${tsFilePath}`, { error });
        return 0;
    }
}

export async function generatePlaylist(videoPath: string): Promise<void> {
    const files = await fsPromises.readdir(videoPath);
    const tsFiles = files
        .filter((f) => f.endsWith(FILE_EXTENSIONS.TS))
        .sort((a, b) => {
            const numA = extractSegmentNumber(a);
            const numB = extractSegmentNumber(b);
            if (numA !== null && numB !== null) return numA - numB;
            if (numA !== null) return -1;
            if (numB !== null) return 1;
            return a.localeCompare(b);
        });

    if (tsFiles.length === 0) return;

    logger.info(`Generating playlist for ${videoPath} (${tsFiles.length} segments)...`);

    const durationPromises = tsFiles.map((file) =>
        limit(() => getSegmentDuration(path.join(videoPath, file)))
    );

    const durations = await Promise.all(durationPromises);
    const validDurations = durations.filter(d => d > 0);
    const targetDuration = validDurations.length > 0
        ? Math.ceil(Math.max(...validDurations))
        : HLS.DEFAULT_TARGET_DURATION;

    const lines = [
        HLS.HEADER,
        HLS.VERSION,
        HLS.MEDIA_SEQUENCE,
        `${HLS.TARGET_DURATION_PREFIX}${targetDuration}`
    ];

    let lastSequence: number | null = null;

    tsFiles.forEach((file, index) => {
        const duration = durations[index];
        if (duration <= 0) return;

        // Check for discontinuity based on numeric sequence
        const currentSequence = extractSegmentNumber(file);
        if (lastSequence !== null && currentSequence !== null && currentSequence !== lastSequence + 1) {
            lines.push(HLS.DISCONTINUITY);
        }
        if (currentSequence !== null) {
            lastSequence = currentSequence;
        }

        lines.push(`${HLS.INF_PREFIX}${duration.toFixed(HLS.DURATION_DECIMAL_PRECISION)},`);
        lines.push(file);
    });

    lines.push(HLS.ENDLIST);

    await fsPromises.writeFile(
        path.join(videoPath, FILE_NAMES.HLS_PLAYLIST),
        lines.join(MISC.NEW_LINE),
        MISC.ENCODING_UTF8
    );

    logger.info(`Playlist generated for ${videoPath}`);
}

const validatedPlaylists = new Set<string>();

export async function ensurePlaylist(videoPath: string): Promise<void> {
    const playlistPath = path.join(videoPath, FILE_NAMES.HLS_PLAYLIST);

    try {
        await fsPromises.access(playlistPath);
    } catch {
        await generatePlaylist(videoPath);
        validatedPlaylists.add(playlistPath);
        return;
    }

    if (validatedPlaylists.has(playlistPath)) return;

    const content = await fsPromises.readFile(playlistPath, MISC.ENCODING_UTF8);
    const { content: fixed, wasFixed } = fixTargetDuration(content);
    if (wasFixed) {
        await fsPromises.writeFile(playlistPath, fixed, MISC.ENCODING_UTF8);
        logger.info(`Fixed TARGETDURATION in ${playlistPath}`);
    }
    validatedPlaylists.add(playlistPath);
}
