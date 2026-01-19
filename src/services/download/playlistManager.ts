import * as path from "path";
import { FileSystemManager } from "../../common/fileSystemManager.js";
import logger from "../../common/logger.js";

export interface SegmentInfo {
    remoteUrl: string;
    localName: string;
    metadata: string[];
}

// Define a type for the URL resolver
export type SegmentUrlResolver = (segmentLine: string) => string;

export class PlaylistManager {
    private readonly segmentsDirPath: string;
    private readonly fullPlaylistPath: string;
    private ignoredSegments: Set<string> = new Set();

    constructor(segmentsDirPath: string) {
        this.segmentsDirPath = segmentsDirPath;
        this.fullPlaylistPath = path.join(this.segmentsDirPath, "playlist.m3u8");
    }

    public addIgnoredSegment(segmentName: string): void {
        this.ignoredSegments.add(segmentName);
    }

    private async getExistingLocalSegments(): Promise<Set<string>> {
        const content = await FileSystemManager.readFile(this.fullPlaylistPath);
        if (!content) {
            return new Set();
        }
        const lines = content.split("\n");
        const segments = new Set<string>();
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed !== "" && !trimmed.startsWith("#")) {
                segments.add(trimmed);
            }
        }
        return segments;
    }

    public async identifyNewSegments(livePlaylistContent: string, urlResolver: SegmentUrlResolver): Promise<SegmentInfo[]> {
        const liveLines = livePlaylistContent.split("\n");
        const newSegments: SegmentInfo[] = [];

        const fileExists = await FileSystemManager.pathExists(this.fullPlaylistPath);

        if (!fileExists) {
            const headerLines = liveLines.filter(
                (line) =>
                    line.startsWith("#EXTM3U") ||
                    line.startsWith("#EXT-X-VERSION") ||
                    line.startsWith("#EXT-X-TARGETDURATION") ||
                    line.startsWith("#EXT-X-MEDIA-SEQUENCE")
            );

            // BUMP TARGET DURATION: Intercept and increase by 1s
            const safeHeaderLines = headerLines.map((line) => {
                if (line.startsWith("#EXT-X-TARGETDURATION:")) {
                    const originalDuration = parseInt(line.split(":")[1], 10);
                    if (!isNaN(originalDuration)) {
                        return `#EXT-X-TARGETDURATION:${originalDuration + 1}`;
                    }
                }
                return line.trim();
            });

            const header = safeHeaderLines.join("\n") + "\n";
            await FileSystemManager.writeFile(this.fullPlaylistPath, header);
        }

        const existingSegments = await this.getExistingLocalSegments();

        for (let i = 0; i < liveLines.length; i++) {
            const line = liveLines[i].trim();
            if (line === "" || line.startsWith("#")) {
                continue;
            }

            // USE THE RESOLVER CALLBACK
            const remoteTsUrl = urlResolver(line);

            // Debug if we are seeing empty segments or issues
            // logger.debug(`[PlaylistManager] Processing line: ${line} -> ${remoteTsUrl}`);

            const tsNameWithQuery = remoteTsUrl.substring(remoteTsUrl.lastIndexOf("/") + 1);
            const localName = tsNameWithQuery.split("?")[0];

            if (!existingSegments.has(localName) && !this.ignoredSegments.has(localName)) {
                const segmentMetadata: string[] = [];
                for (let j = i - 1; j >= 0; j--) {
                    const metaLine = liveLines[j].trim();
                    if (metaLine.startsWith("#")) {
                        const isHeaderTag =
                            metaLine.startsWith("#EXTM3U") ||
                            metaLine.startsWith("#EXT-X-VERSION") ||
                            metaLine.startsWith("#EXT-X-TARGETDURATION") ||
                            metaLine.startsWith("#EXT-X-MEDIA-SEQUENCE");
                        if (isHeaderTag) break;
                        segmentMetadata.unshift(metaLine);
                    } else {
                        break;
                    }
                }
                newSegments.push({ remoteUrl: remoteTsUrl, localName, metadata: segmentMetadata });
            }
        }

        return newSegments;
    }

    public async appendSegmentToPlaylist(segment: SegmentInfo): Promise<void> {
        const entry = [...segment.metadata, segment.localName].join("\n") + "\n";
        await FileSystemManager.appendFile(this.fullPlaylistPath, entry);
    }

    public async finalizePlaylist(): Promise<void> {
        logger.info(`Finalizing playlist: ${this.fullPlaylistPath}`);
        const endTag = "#EXT-X-ENDLIST\n";
        await FileSystemManager.appendFile(this.fullPlaylistPath, endTag);
    }
}