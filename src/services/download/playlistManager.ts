// src/services/download/playlistManager.ts
import * as path from "path";
import { FileSystemManager } from "../../common/fileSystemManager.js";

export interface SegmentToDownload {
    remoteUrl: string;
    localName: string;
}

export class PlaylistManager {
    private segmentsDirPath: string;
    private localPlaylistPath: string;
    private processedRemoteTsUrls: Set<string> = new Set();

    constructor(segmentsDirPath: string) {
        this.segmentsDirPath = segmentsDirPath;
        this.localPlaylistPath = path.join(this.segmentsDirPath, "playlist.m3u8");
    }

    /**
     * Processes the live HLS playlist content from the server.
     * It writes a local version of the playlist with relative paths and
     * returns a list of new, remote .ts segment URLs that need to be downloaded.
     * @param livePlaylistContent - The raw text content of the live playlist.
     * @param cinemaApiUrl - The base URL for constructing full segment URLs.
     * @returns A promise that resolves to an array of objects representing segments to download.
     */
    public async processLivePlaylist(livePlaylistContent: string, cinemaApiUrl: string): Promise<SegmentToDownload[]> {
        const liveLines = livePlaylistContent.split("\n");

        const segmentsToDownload: SegmentToDownload[] = [];
        const localPlaylistLines: string[] = [];

        for (const line of liveLines) {
            if (line.trim() === "") continue;

            if (line.startsWith("#")) {
                localPlaylistLines.push(line);
            } else {
                // This is a segment URL.
                const remoteTsUrl = line.startsWith("/") ? `${cinemaApiUrl}${line}` : line;

                // For the local playlist, we just want the filename.
                // e.g., from .../12345.ts?query=param -> 12345.ts
                const tsNameWithQuery = remoteTsUrl.substring(remoteTsUrl.lastIndexOf("/") + 1);
                const tsName = tsNameWithQuery.split("?")[0];
                localPlaylistLines.push(tsName);

                // Check if we need to download it.
                if (!this.processedRemoteTsUrls.has(remoteTsUrl)) {
                    segmentsToDownload.push({ remoteUrl: remoteTsUrl, localName: tsName });
                    this.processedRemoteTsUrls.add(remoteTsUrl);
                }
            }
        }

        const localPlaylistData = localPlaylistLines.join("\n");
        // This write operation is the core of the future playlist manager feature.
        await FileSystemManager.writeFile(this.localPlaylistPath, localPlaylistData);

        return segmentsToDownload;
    }
}
