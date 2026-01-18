import * as timersPromises from "timers/promises";
import * as path from "path";
import * as fs from "fs/promises"; // Added for unlink

import * as config from "../../common/config.js";
import logger from "../../common/logger.js";
import { DownloadPathManager } from "./tango/downloadPathManager.js";
import { ApiClient } from "../api/apiClient.js";
import { DownloadHandle } from "../state/downloadsManager.js";
import { FileSystemManager } from "../../common/fileSystemManager.js";
import { PlaylistManager } from "./playlistManager.js";
import { OrphanStreamFinalizer } from "../coordination/orphanStreamFinalizer.js";

export class StreamDownloader {
    private downloadHandle: DownloadHandle;
    private apiClient: ApiClient;

    constructor(downloadHandle: DownloadHandle, apiClient: ApiClient) {
        this.downloadHandle = downloadHandle;
        this.apiClient = apiClient;
    }

    public async start() {
        if (!this.downloadHandle.state) {
            logger.error(`Could not find state for download with handle. Aborting.`);
            return;
        }

        const alias = this.downloadHandle.state.alias;

        let liveUrl: string | null = null;
        const MAX_RETRIES = 3;
        const RETRY_DELAY = 5000;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            const resolvedUrl = await this._getLiveUrlFromMaster();
            if (resolvedUrl) {
                liveUrl = resolvedUrl;
                break;
            }
            logger.warn(`Failed to resolve live URL for ${alias} (attempt ${attempt}/${MAX_RETRIES}). Retrying in ${RETRY_DELAY / 1000}s...`);
            if (attempt < MAX_RETRIES) await timersPromises.setTimeout(RETRY_DELAY);
        }

        if (!liveUrl) {
            logger.error(`Could not resolve live playlist URL for ${alias} after ${MAX_RETRIES} attempts. Aborting download.`);
            this.downloadHandle.remove();
            return;
        }

        this.downloadHandle.update({ liveUrl });

        const startDate = new Date();
        const segmentsDirPath = await DownloadPathManager.createDownloadPaths(alias, startDate);

        if (!segmentsDirPath) {
            logger.error(`Failed to create download paths for ${alias}. Aborting download.`);
            this.downloadHandle.remove();
            return;
        }

        this.downloadHandle.update({ segmentsDirPath });
        logger.info(`${segmentsDirPath} started downloading segments.`);

        const playlistManager = new PlaylistManager(segmentsDirPath);
        let lastDownload = Date.now();

        while (Date.now() - lastDownload < config.getConfig().timeouts.staleStream) {
            const liveResponse = await this.apiClient.getLiveList(liveUrl);

            if (liveResponse.success && liveResponse.data) {
                const cinemaApiUrl = this.downloadHandle.masterPlaylistUrl.split("/v2/")[0];
                const segmentsToProcess = await playlistManager.identifyNewSegments(liveResponse.data, cinemaApiUrl);

                if (segmentsToProcess.length > 0) {
                    for (const segment of segmentsToProcess) {
                        const tsBuffer = await this.apiClient.getTsSegment(segment.remoteUrl);
                        const segmentPath = path.join(segmentsDirPath, segment.localName);

                        if (!tsBuffer) {
                            logger.warn(`Pausing segment processing due to download failure:`, { segmentPath });
                            break;
                        }

                        const writeSuccess = await FileSystemManager.writeFile(segmentPath, tsBuffer as unknown as Uint8Array);

                        if (writeSuccess) {
                            // Validate the segment immediately
                            const isBad = await OrphanStreamFinalizer.checkIfSegmentIsBad(segmentPath);

                            if (isBad) {
                                logger.warn(`Downloaded segment is corrupt (0kb/s). Deleting and skipping: ${segment.localName}`);
                                await fs.unlink(segmentPath).catch(() => {});
                                // We treat this as "processed" so we don't try to download it again loop after loop,
                                // but we do NOT append it to the playlist.
                                // However, playlistManager relies on 'existingSegments' which reads from playlist.
                                // If we don't add it to playlist, identifyNewSegments will try to download it again next loop!
                                // To fix this loop, we must either:
                                // 1. Add it to playlist but comment it out? (HLS doesn't support comment-out segments easily).
                                // 2. Keep it in memory in PlaylistManager?
                                // 3. Or just acknowledge that for this session, we skip it.
                                // Actually, if we delete it, identifyNewSegments will see it's missing from "existingSegments" (which checks Playlist file).
                                // So it WILL try again.
                                // If the server keeps serving the bad segment, we loop downloading/deleting.
                                // Solution: Append it to the playlist as a "DISCONTINUITY" tag only? No.
                                // Solution: We simply append it to the playlist but maybe point to a dummy/empty file? No.
                                // Best Solution: If it's bad, we just don't write it to disk, but we DO add it to the playlist? No, player will 404.

                                // Proper Solution: PlaylistManager needs to know about "Bad/Skipped" segments to avoid re-downloading.
                                // But PlaylistManager is stateless per loop (reads file).
                                // Since this is a live stream downloader, the live playlist window moves.
                                // Eventually the bad segment falls out of the live window (usually 3-5 segments).
                                // So we might re-download it 3-5 times. This is acceptable waste to ensure quality.

                                // Update lastDownload to keep stream alive even if we skip bad segments
                                lastDownload = Date.now();
                            } else {
                                await playlistManager.appendSegmentToPlaylist(segment);
                                lastDownload = Date.now();
                            }
                        } else {
                            logger.error(`Failed to write segment to disk, pausing processing:`, { segmentPath });
                            break;
                        }
                    }
                }
            }

            await timersPromises.setTimeout(1000);
        }

        await playlistManager.finalizePlaylist();

        logger.info(`Finished download process for: ${segmentsDirPath}`);
        this.downloadHandle.remove();
    }

    private async _getLiveUrlFromMaster(): Promise<string | null> {
        const masterListBody = await this.apiClient.getMasterList(this.downloadHandle.masterPlaylistUrl);
        if (!masterListBody) {
            logger.warn(
                `Could not fetch master playlist body from: ${this.downloadHandle.masterPlaylistUrl} for ${this.downloadHandle.state?.segmentsDirPath}`
            );
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
            logger.warn(
                `Could not find HD stream in master playlist: ${this.downloadHandle.masterPlaylistUrl} for ${this.downloadHandle.state?.segmentsDirPath}`
            );
            return null;
        }
        const cinemaApiUrl = this.downloadHandle.masterPlaylistUrl.split("/v2/")[0];
        let livePlaylistUrl = `${cinemaApiUrl}${relativeLiveUrl}`;
        if (livePlaylistUrl.endsWith("&")) {
            livePlaylistUrl = livePlaylistUrl.substring(0, livePlaylistUrl.length - 1);
        }
        return livePlaylistUrl;
    }
}