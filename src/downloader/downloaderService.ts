// src/downloader/downloaderService.ts
import * as fsPromises from "fs/promises";
import * as timersPromises from "timers/promises";
import * as path from "path";
import * as childProcess from "child_process";
import * as url from "url";

import * as config from "../common/config.js";
import logger from "../common/logger.js";
import * as storage from "../common/storage.js";
import * as utils from "../common/utils.js";
import * as requests from "./requests.js";

// --- Correct Path Resolution ---
const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = utils.findProjectRoot(__dirname);

// --- Local Interfaces ---
interface ActiveDownload {
    streamerId: string;
    alias: string;
    liveUrl: string | null;
}

export class DownloaderService {
    private activeDownloads: Map<string, ActiveDownload> = new Map();
    private tokens: requests.Tokens | null = null;

    constructor() {
        logger.info("DownloaderService initialized.");
    }

    public start() {
        logger.info("Starting Downloader Service...");
        this._startTokenWatcher(); // Start the background token refresher
        this._startStreamWatcher(); // Start the main stream polling loop
    }

    /**
     * Periodically reads the session file and updates the internal token state.
     */
    private async _startTokenWatcher() {
        const refreshInterval = config.getConfig().intervals.shortTokenRefresh;
        while (true) {
            try {
                const cfg = config.getConfig();
                const sessionFileName = cfg.fileNames.session;
                const sessionFilePath = path.resolve(projectRoot, sessionFileName);

                const data = await fsPromises.readFile(sessionFilePath, "utf-8");
                const session = JSON.parse(data);

                if (session.tangoST && session.tt && session.ttu && session.tte) {
                    this.tokens = {
                        st: session.tangoST,
                        tt: session.tt,
                        ttu: session.ttu,
                        tte: session.tte,
                    };
                } else {
                    if (this.tokens) logger.warn("Session file is missing required tokens. Clearing internal state.");
                    this.tokens = null;
                }
            } catch (error: any) {
                if (error.code !== "ENOENT") {
                    logger.error("Failed to read tokens from session file", { error });
                }
                if (this.tokens) logger.warn("Session file not found. Clearing internal token state.");
                this.tokens = null;
            }
            await timersPromises.setTimeout(refreshInterval);
        }
    }

    /**
     * The main loop that polls the 'following' endpoint and manages downloads.
     */
    private async _startStreamWatcher() {
        let lastKnownTotal = -1;

        while (true) {
            try {
                if (!this.tokens) {
                    logger.warn("Tokens not available. Downloader is waiting for auth service to provide them...");
                    await timersPromises.setTimeout(config.getConfig().intervals.shortTokenRefresh);
                    continue;
                }

                const streamIdsResponseBody = await requests.getFollowingResponseBody(this.tokens);

                const currentTotal = this.activeDownloads.size;
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
                            if (!this.activeDownloads.has(masterPlaylistUrl)) {
                                this.activeDownloads.set(masterPlaylistUrl, {
                                    streamerId: streamerId,
                                    alias: streamerId,
                                    liveUrl: null,
                                });
                                logger.info(`Discovered new stream from ${streamerId}. Initiating download...`);
                                this._updateStatusFile();
                                this._initiateAndDownloadStream(streamerId, masterPlaylistUrl);
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

    /**
     * The long-running process for downloading a single stream. It relies on the
     * periodically updated `this.tokens` from the token watcher.
     */
    private async _initiateAndDownloadStream(streamerId: string, masterListUrl: string) {
        let alias = streamerId;
        // ... (The rest of this function is nearly identical to before, but it uses `this.tokens`)
        // The key is that `this.tokens` is automatically kept fresh by `_startTokenWatcher`.
        let tsFilePath: string | null = null;
        let segmentsDirPath: string | null = null;
        let totalSegmentsDownloaded = 0;

        const downloadState = this.activeDownloads.get(masterListUrl);
        if (!downloadState) {
            logger.error(`Could not find state for download with master URL: ${masterListUrl}. Aborting.`);
            return;
        }

        try {
            if (!this.tokens) throw new Error(`Tokens not available at start of download for ${streamerId}`);

            alias = await requests.getStreamerAlias(streamerId, this.tokens);
            downloadState.alias = alias;
            this._updateStatusFile();

            let liveUrl: string | null = null;
            const MAX_RETRIES = 3;
            const RETRY_DELAY = 5000;

            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                if (!this.tokens) throw new Error("Tokens disappeared while resolving live URL.");
                const resolvedUrl = await this._getLiveUrlFromMaster(masterListUrl);
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
            this._updateStatusFile();

            // ... (FFmpeg setup and the main `while (true)` loop for downloading segments)
            // The existing `while (true)` loop here is now correct, because `this.tokens` will be fresh on each iteration.
            const startDate = new Date();
            const paths = storage.createDownloadPaths(alias, startDate);
            tsFilePath = paths.tsFilePath;
            segmentsDirPath = paths.segmentsDirPath;

            logger.info(`${utils.getFormattedDate(startDate)} ${alias} started downloading.`);
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
                if (!this.tokens) {
                    logger.warn(`Tokens became unavailable for ${alias} mid-stream. Assuming stream has ended.`);
                    break;
                }

                const liveResponse = await requests.getLiveList(liveUrl, this.tokens);

                // ... (The rest of the segment downloading logic is unchanged)
                // ...
                if (liveResponse.success && liveResponse.data) {
                    lastOnline = Date.now();
                    first404Timestamp = null;
                    const liveLines = liveResponse.data.split("\n").filter((line) => line.trim() !== "");
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
                                if (!ffmpegProcess.stdin.destroyed) ffmpegProcess.stdin.write(tsBuffer);
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
            // ... (FFmpeg close logic)
        } catch (error) {
            logger.error(`Download process for ${alias} failed fatally.`, { error });
        } finally {
            logger.info(`${utils.getFormattedDate()} Finished download process for: ${alias}`);
            this.activeDownloads.delete(masterListUrl);
            this._updateStatusFile();
        }
    }

    // --- Helper Methods ---
    private async _updateStatusFile() {
        try {
            const cfg = config.getConfig();
            const statusFilePath = path.join(projectRoot, cfg.fileNames.liveStatus);
            const activeDownloads = Array.from(this.activeDownloads.entries()).map(([masterPlaylistUrl, downloadInfo]) => ({
                masterPlaylistUrl,
                ...downloadInfo,
            }));
            const status = { activeDownloads, lastUpdated: new Date().toISOString() };
            await fsPromises.writeFile(statusFilePath, JSON.stringify(status, null, 2));
        } catch (error) {
            logger.error("Failed to write download status to live-status.json", { error });
        }
    }

    private async _getLiveUrlFromMaster(masterPlaylistUrl: string): Promise<string | null> {
        if (!this.tokens) return null;
        try {
            const masterListBody = await requests.getMasterList(masterPlaylistUrl, this.tokens);
            if (!masterListBody) {
                logger.warn(`Could not fetch master playlist body from: ${masterPlaylistUrl}`);
                return null;
            }
            const masterLines = masterListBody.split("\n").filter((line) => line.trim() !== "");
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
}
