// src/downloaderService.ts
import * as fsPromises from "fs/promises";
import * as timersPromises from "timers/promises";
import * as path from "path";
import * as childProcess from "child_process";
import * as url from "url";

import * as config from "../config.js";
import logger from "../logger.js";
import * as storage from "../storage.js";

import * as downloaderUtils from "./downloaderUtils.js";
import * as requests from "./requests.js";

// --- Download State ---
interface ActiveDownload {
    streamerId: string;
    alias: string;
    liveUrl: string | null; // Is null until the master playlist is resolved
}
// The key is the master playlist URL from the /following API response
const _activeDownloads: Map<string, ActiveDownload> = new Map();

// --- Download Getters ---
// The Map is mutated directly, so we just need a getter.
export function getActiveDownloads(): Map<string, ActiveDownload> {
    return _activeDownloads;
}

// --- Correct Path Resolution ---
const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

// --- Local Helpers for Downloader ---
function getResponseBodyLines(responseBody: string): string[] {
    return responseBody.split("\n").filter((line) => line.trim() !== "");
}

async function readTokensFromSessionFile(): Promise<requests.Tokens | null> {
    try {
        const cfg = config.getConfig();
        const sessionFileName = cfg.fileNames.session;
        // FIX: Resolve path from project root, not storagePath
        const sessionFilePath = path.resolve(projectRoot, sessionFileName);

        const data = await fsPromises.readFile(sessionFilePath, "utf-8");
        const session = JSON.parse(data);
        if (session.tangoST && session.tt && session.ttu && session.tte) {
            return {
                st: session.tangoST,
                tt: session.tt,
                ttu: session.ttu,
                tte: session.tte,
            };
        }
        logger.warn("Session file is missing some required tokens (st, tt, ttu, tte).");
        return null;
    } catch (error: any) {
        if (error.code !== "ENOENT") {
            logger.error("Failed to read tokens from session file", { error });
        }
        return null;
    }
}

async function updateStatusFile() {
    try {
        const cfg = config.getConfig();
        const statusFilePath = path.join(cfg.storagePath, cfg.fileNames.liveStatus);

        const activeDownloads = Array.from(getActiveDownloads().entries()).map(([masterPlaylistUrl, downloadInfo]) => ({
            masterPlaylistUrl,
            ...downloadInfo,
        }));

        const status = {
            activeDownloads,
            lastUpdated: new Date().toISOString(),
        };
        await fsPromises.writeFile(statusFilePath, JSON.stringify(status, null, 2));
    } catch (error) {
        logger.error("Failed to write download status to live-status.json", { error });
    }
}

async function getLiveUrlFromMaster(masterPlaylistUrl: string, tokens: requests.Tokens): Promise<string | null> {
    try {
        const masterListBody = await requests.getMasterList(masterPlaylistUrl, tokens);
        if (!masterListBody) {
            logger.warn(`Could not fetch master playlist body from: ${masterPlaylistUrl}`);
            return null;
        }

        const masterLines = getResponseBodyLines(masterListBody);
        let relativeLiveUrl;
        for (let i = 0; i < masterLines.length; i++) {
            if (masterLines[i].includes("RESOLUTION=1280x720")) {
                relativeLiveUrl = masterLines[i + 1];
                break;
            }
        }

        if (!relativeLiveUrl) {
            logger.warn(`Could not find HD stream in master playlist: ${masterPlaylistUrl}`);
            return null;
        }

        const cinemaApiUrl = masterPlaylistUrl.split("/v2/")[0];
        let livePlaylistUrl = `${cinemaApiUrl}${relativeLiveUrl}`;
        if (livePlaylistUrl.endsWith("&")) {
            livePlaylistUrl = livePlaylistUrl.substring(0, livePlaylistUrl.length - 1);
        }
        return livePlaylistUrl;
    } catch (error) {
        logger.error(`Error resolving live URL from master: ${masterPlaylistUrl}`, { error });
        return null;
    }
}

// --- Core Service Logic ---

async function initiateAndDownloadStream(streamerId: string, masterListUrl: string, tokens: requests.Tokens) {
    let alias = streamerId;
    let tsFilePath: string | null = null;
    let segmentsDirPath: string | null = null;
    let totalSegmentsDownloaded = 0;

    const downloadState = getActiveDownloads().get(masterListUrl);
    if (!downloadState) {
        logger.error(`Could not find state for download with master URL: ${masterListUrl}. Aborting.`);
        return;
    }

    try {
        alias = await requests.getStreamerAlias(streamerId, tokens);
        downloadState.alias = alias;
        await updateStatusFile();

        let liveUrl: string | null = null;
        const MAX_RETRIES = 3;
        const RETRY_DELAY = 5000;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            const resolvedUrl = await getLiveUrlFromMaster(masterListUrl, tokens);
            if (resolvedUrl) {
                liveUrl = resolvedUrl;
                break;
            }
            logger.warn(`Failed to resolve live URL for ${alias} (attempt ${attempt}/${MAX_RETRIES}). Retrying in ${RETRY_DELAY / 1000}s...`);
            if (attempt < MAX_RETRIES) await timersPromises.setTimeout(RETRY_DELAY);
        }

        if (!liveUrl) {
            throw new Error(`Could not resolve live playlist URL for ${alias} after ${MAX_RETRIES} attempts.`);
        }

        downloadState.liveUrl = liveUrl;
        await updateStatusFile();

        const startDate = new Date();
        const paths = downloaderUtils.createDownloadPaths(alias, startDate);
        tsFilePath = paths.tsFilePath;
        segmentsDirPath = paths.segmentsDirPath;

        logger.info(`${downloaderUtils.getFormattedDate(startDate)} ${alias} started downloading.`);
        logger.info(`- Live URL: ${liveUrl}`);
        logger.info(`- TS (growing): ${tsFilePath}`);
        logger.info(`- Segments will be saved to: ${segmentsDirPath}`);

        const ffmpegProcess = childProcess.spawn("ffmpeg", [
            "-hide_banner",
            "-loglevel",
            "error",
            "-stats",
            "-fflags",
            "+genpts",
            "-i",
            "pipe:0",
            "-c",
            "copy",
            "-f",
            "mpegts",
            "-y",
            tsFilePath,
        ]);
        ffmpegProcess.stderr.on("data", (data) => logger.verbose(`ffmpeg-ts (${path.basename(tsFilePath!)}): ${data.toString()}`));
        ffmpegProcess.on("error", (err) => logger.error(`Failed to start FFmpeg (ts) for ${alias}. Is ffmpeg installed?`, { error: err }));
        ffmpegProcess.stdin.on("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EPIPE") {
                logger.warn(`ffmpeg-ts (${alias}): Broken pipe. FFmpeg process likely closed prematurely.`);
            } else {
                logger.error(`ffmpeg-ts (${alias}): stdin stream error.`, { error: err });
            }
        });

        let lastOnline = Date.now();
        let first404Timestamp: number | null = null;
        const downloadedTsUrls: Set<string> = new Set();
        let lastSegmentDownloadedTimestamp = Date.now();

        while (true) {
            const liveResponse = await requests.getLiveList(liveUrl, tokens);
            if (liveResponse.success && liveResponse.data) {
                lastOnline = Date.now();
                first404Timestamp = null;
                const liveLines = getResponseBodyLines(liveResponse.data);
                const cinemaApiUrl = masterListUrl.split("/v2/")[0];

                const segmentsToDownload: string[] = [];
                for (let i = 0; i < liveLines.length; i++) {
                    if (liveLines[i].startsWith("/v2/")) {
                        const tsUrl = `${cinemaApiUrl}${liveLines[i]}`;
                        if (!downloadedTsUrls.has(tsUrl)) {
                            segmentsToDownload.push(tsUrl);
                            downloadedTsUrls.add(tsUrl);
                        }
                    }
                }

                if (segmentsToDownload.length > 0) {
                    for (const tsUrl of segmentsToDownload) {
                        const tsBuffer = await requests.getTsSegment(tsUrl);
                        if (tsBuffer) {
                            lastSegmentDownloadedTimestamp = Date.now();
                            totalSegmentsDownloaded++;

                            if (!ffmpegProcess.stdin.destroyed) {
                                ffmpegProcess.stdin.write(tsBuffer);
                            }

                            try {
                                const tsNameHls = tsUrl.substring(tsUrl.lastIndexOf("/") + 1);
                                const tsName = tsNameHls.substring(0, tsNameHls.lastIndexOf("?"));
                                const segmentPath = path.join(segmentsDirPath, tsName);
                                fsPromises.writeFile(segmentPath, tsBuffer as unknown as Uint8Array);
                            } catch (error) {
                                logger.error(`Failed to save raw segment for ${alias}`, { error });
                            }
                        }
                    }
                }
            } else {
                if (liveResponse.status === 404) {
                    if (first404Timestamp === null) {
                        first404Timestamp = Date.now();
                        logger.warn(
                            `Received first 404 for playlist of ${alias}. Will stop in ${config.getConfig().timeouts.streamEnd / 1000}s if it persists.`
                        );
                    }
                }
            }

            if (Date.now() - lastSegmentDownloadedTimestamp > config.getConfig().timeouts.staleStream) {
                logger.info(`No new segments for ${alias} in ${config.getConfig().timeouts.staleStream / 1000}s. Assuming stream has ended.`);
                break;
            }

            if (first404Timestamp && Date.now() - first404Timestamp > config.getConfig().timeouts.streamEnd) {
                logger.info(`Stream for ${alias} appears to have ended (persistent 404). Stopping download.`);
                break;
            }
            if (Date.now() - lastOnline > config.getConfig().timeouts.networkBuffer) {
                logger.warn(
                    `No successful playlist fetch for ${alias} in ${config.getConfig().timeouts.networkBuffer / 1000}s. Assuming stream/connection loss.`
                );
                break;
            }
            await timersPromises.setTimeout(config.getConfig().intervals.downloadBuffer);
        }

        if (!ffmpegProcess.stdin.destroyed) {
            ffmpegProcess.stdin.end();
        }

        await new Promise<void>((resolve) =>
            ffmpegProcess.on("close", (code) => {
                logger.info(`FFmpeg (ts) process for ${alias} finished with code ${code}.`);
                resolve();
            })
        );

        if (totalSegmentsDownloaded === 0) {
            logger.warn(`No segments were downloaded for ${alias}, moving empty directory and file to trash.`);
            if (tsFilePath) await storage.moveToTrash(tsFilePath);
            if (segmentsDirPath) await storage.moveToTrash(segmentsDirPath);
        }
    } catch (error) {
        logger.error(`Download process for ${alias} failed fatally.`, { error });
    } finally {
        logger.info(`${downloaderUtils.getFormattedDate()} Finished download process for: ${alias}`);
        getActiveDownloads().delete(masterListUrl);
        await updateStatusFile();
    }
}

export async function startDownloaderService() {
    logger.info("Starting stream watcher...");
    let lastKnownTotal = -1;

    while (true) {
        try {
            const tokens = await readTokensFromSessionFile();
            if (!tokens) {
                logger.warn("Tokens not available in session.json. Downloader is waiting for auth service to provide them...");
                await timersPromises.setTimeout(config.getConfig().intervals.shortTokenRefresh);
                continue;
            }

            const streamIdsResponseBody = await requests.getFollowingResponseBody(tokens);

            const activeDownloads = getActiveDownloads();
            const currentTotal = activeDownloads.size;
            if (currentTotal !== lastKnownTotal) {
                logger.info(`Watching for streams... Total active/pending: ${currentTotal}`);
                lastKnownTotal = currentTotal;
            }

            if (streamIdsResponseBody?.entities?.stream) {
                const streamIds: string[] = Object.keys(streamIdsResponseBody.entities.stream);

                for (const streamId of streamIds) {
                    const stream = streamIdsResponseBody.entities.stream[streamId];
                    const masterPlaylistUrl = stream.playlistUrl;
                    const streamerId = stream.broadcasterId;

                    if (stream.kind === "PUBLIC" && streamerId && masterPlaylistUrl) {
                        if (!activeDownloads.has(masterPlaylistUrl)) {
                            activeDownloads.set(masterPlaylistUrl, {
                                streamerId: streamerId,
                                alias: streamerId,
                                liveUrl: null,
                            });
                            logger.info(`Discovered new stream from ${streamerId}. Initiating download...`);
                            await updateStatusFile();

                            initiateAndDownloadStream(streamerId, masterPlaylistUrl, tokens);
                        }
                    }
                }
            } else {
                logger.verbose("Poll complete: No stream entities found in the response.");
            }
        } catch (error) {
            logger.error("Failed to poll for following streams.", { error });
        }
        await timersPromises.setTimeout(config.getConfig().intervals.pollFollowing);
    }
}
