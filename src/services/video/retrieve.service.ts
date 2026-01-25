import { promises as fsPromises } from "fs";
import path from "path";
import * as types from "../../core/types.js";
import * as config from "../../core/config.js";
import * as utils from "../../core/utils.js";
import * as constants from "../../core/constants.js";

export async function getAllVideos(provider: string = "tango"): Promise<{ videos: types.VideoItem[], timings: Record<string, number> }> {
    const timings: Record<string, number> = {};
    const tStart = Date.now();

    const liveFolders = await utils.getLiveFolders();
    timings['live-folders'] = Date.now() - tStart;

    const paths = config.getProviderPaths(provider);
    const providerPaths = [
        { path: paths.downloader, type: constants.ALL_VIDEO_PATHS_TYPES.ORIGINAL },
        { path: paths.edited, type: constants.ALL_VIDEO_PATHS_TYPES.EDITED },
        { path: paths.converted, type: constants.ALL_VIDEO_PATHS_TYPES.EDITED },
    ];

    // Phase 1: Readdir
    const tReaddirStart = Date.now();
    const allEntries: { name: string; fullPath: string; type: types.VideoType }[] = [];

    await Promise.all(providerPaths.map(async (dirConfig) => {
        try {
            const entries = await fsPromises.readdir(dirConfig.path, { withFileTypes: true });
            entries.forEach(entry => {
                if (entry.isDirectory()) {
                    allEntries.push({
                        name: entry.name,
                        fullPath: path.join(dirConfig.path, entry.name),
                        type: dirConfig.type
                    });
                }
            });
        } catch (error) {
            // Directory might not exist or be inaccessible
        }
    }));
    timings['readdir'] = Date.now() - tReaddirStart;

    // Phase 2: Processing (Reading durations)
    const tProcessStart = Date.now();

    // Instrumentation accumulators
    let totalIoTime = 0;
    let totalParseTime = 0;

    const videos: types.VideoItem[] = await Promise.all(allEntries.map(async (entry) => {
        const isLive = liveFolders.has(entry.name);
        let duration = 0;

        if (!isLive) {
            // INLINED Logic from utils.getPlaylistDuration for profiling
            try {
                const playlistPath = path.join(entry.fullPath, constants.FILE_NAMES.HLS_PLAYLIST);

                // Measure IO
                const tIoStart = performance.now();
                const content = await fsPromises.readFile(playlistPath, constants.MISC.ENCODING_UTF8);
                totalIoTime += (performance.now() - tIoStart);

                // Measure Parse
                const tParseStart = performance.now();
                const lines = content.split(constants.MISC.NEW_LINE);
                for (const line of lines) {
                    if (line.startsWith(constants.HLS.INF_PREFIX)) {
                        const valueStr = line.substring(constants.HLS.INF_PREFIX.length).split(',')[0];
                        const value = parseFloat(valueStr);
                        if (!isNaN(value)) {
                            duration += value;
                        }
                    }
                }
                totalParseTime += (performance.now() - tParseStart);

            } catch {
                duration = 0;
            }
        }

        return {
            filename: entry.name,
            type: entry.type,
            size: 0,
            duration: duration,
            isLive: isLive
        };
    }));

    timings['duration-calc'] = Date.now() - tProcessStart;
    timings['duration-io-sum'] = Math.round(totalIoTime);
    timings['duration-parse-sum'] = Math.round(totalParseTime);

    // Phase 3: Sorting
    const tSortStart = Date.now();
    videos.sort((a, b) => a.filename.localeCompare(b.filename));
    timings['sorting'] = Date.now() - tSortStart;

    // Stats
    timings['count'] = videos.length;

    return { videos, timings };
}