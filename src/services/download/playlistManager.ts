// src/services/download/playlistManager.ts
import * as path from "path";
import { FileSystemManager } from "../../common/fileSystemManager.js";
import logger from "../../common/logger.js";

export interface SegmentToDownload {
    remoteUrl: string;
    localName: string;
}

export class PlaylistManager {
    private segmentsDirPath: string;
    private fullPlaylistPath: string;

    constructor(segmentsDirPath: string) {
        this.segmentsDirPath = segmentsDirPath;
        this.fullPlaylistPath = path.join(this.segmentsDirPath, "playlist.m3u8");
    }

    private async getExistingLocalSegments(): Promise<Set<string>> {
        const content = await FileSystemManager.readFile(this.fullPlaylistPath);
        if (!content) {
            return new Set();
        }
        const lines = content.split("\n");
        const segments = new Set<string>();
        for (const line of lines) {
            if (line.trim() !== "" && !line.startsWith("#")) {
                segments.add(line);
            }
        }
        return segments;
    }

    public async processLivePlaylist(livePlaylistContent: string, cinemaApiUrl: string): Promise<SegmentToDownload[]> {
        const liveLines = livePlaylistContent.split("\n");
        const segmentsToDownload: SegmentToDownload[] = [];
        const newPlaylistEntries: string[] = [];

        const fileExists = await FileSystemManager.pathExists(this.fullPlaylistPath);

        // If playlist file doesn't exist, create it with a header.
        if (!fileExists) {
            const headerLines = liveLines.filter(
                (line) =>
                    line.startsWith("#EXTM3U") ||
                    line.startsWith("#EXT-X-VERSION") ||
                    line.startsWith("#EXT-X-TARGETDURATION") ||
                    line.startsWith("#EXT-X-MEDIA-SEQUENCE")
            );
            const header = headerLines.join("\n") + "\n";
            await FileSystemManager.writeFile(this.fullPlaylistPath, header);
        }

        // Use the file as the source of truth to see what we've already saved.
        const existingSegments = await this.getExistingLocalSegments();

        // Process segments from the live playlist
        for (let i = 0; i < liveLines.length; i++) {
            const line = liveLines[i];
            if (line.trim() === "" || line.startsWith("#")) {
                continue;
            }

            // `line` is a relative segment URL
            const remoteTsUrl = line.startsWith("/") ? `${cinemaApiUrl}${line}` : line;

            const tsNameWithQuery = remoteTsUrl.substring(remoteTsUrl.lastIndexOf("/") + 1);
            const localName = tsNameWithQuery.split("?")[0];

            if (!existingSegments.has(localName)) {
                // This is a new segment, let's add it.
                segmentsToDownload.push({ remoteUrl: remoteTsUrl, localName });

                // Find the metadata lines for this segment that came before it
                const segmentMetadata: string[] = [];
                for (let j = i - 1; j >= 0; j--) {
                    if (liveLines[j].startsWith("#")) {
                        segmentMetadata.unshift(liveLines[j]);
                    } else {
                        break;
                    }
                }
                newPlaylistEntries.push(...segmentMetadata, localName);
            }
        }

        if (newPlaylistEntries.length > 0) {
            const appendData = newPlaylistEntries.join("\n") + "\n";
            await FileSystemManager.appendFile(this.fullPlaylistPath, appendData);
        }

        return segmentsToDownload;
    }

    public async finalizePlaylist(): Promise<void> {
        logger.info(`Finalizing playlist: ${this.fullPlaylistPath}`);
        const endTag = "#EXT-X-ENDLIST\n";
        await FileSystemManager.appendFile(this.fullPlaylistPath, endTag);
    }
}
