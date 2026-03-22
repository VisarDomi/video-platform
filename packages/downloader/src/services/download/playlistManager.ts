import * as path from "path";
import { FileSystemManager } from "../../common/fileSystemManager.js";
import logger from "../../common/logger.js";
import { fixTargetDuration } from "shared";

export interface SegmentInfo {
    remoteUrl: string;
    localName: string;
    metadata: string[];
    accurateDuration?: number;
}

export type SegmentUrlResolver = (segmentLine: string) => string;

/**
 * Owns the playlist file. All writes go through this class.
 *
 * Invariant: the playlist file is never created without a valid header.
 * Quality changes that arrive before the first segment are buffered
 * and flushed atomically with the header when the first segment is
 * appended. This prevents the file from starting with a bare
 * DISCONTINUITY+MAP entry that would later be overwritten.
 */
export class PlaylistManager {
    private readonly segmentsDirPath: string;
    private readonly fullPlaylistPath: string;
    private ignoredSegments: Set<string> = new Set();
    private seenRemoteUrls: Set<string> = new Set();
    private lastSegmentNumber: number = -1;
    public startSequence: number = 0;
    private pendingHeader: string[] | null = null;
    private pendingQualityChanges: string[] = [];
    private currentTargetDuration: number = 0;

    constructor(segmentsDirPath: string) {
        this.segmentsDirPath = segmentsDirPath;
        this.fullPlaylistPath = path.join(this.segmentsDirPath, "playlist.m3u8");
    }

    private getExtinfDuration(metadata: string[]): number {
        const extinf = metadata.find((l) => l.startsWith("#EXTINF:"));
        if (extinf) {
            const val = parseFloat(extinf.slice("#EXTINF:".length).replace(",", ""));
            if (!isNaN(val)) return val;
        }
        return 2;
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

        if (!fileExists && !this.pendingHeader) {
            const headerLines = liveLines.filter(
                (line) =>
                    line.startsWith("#EXTM3U") ||
                    line.startsWith("#EXT-X-VERSION") ||
                    line.startsWith("#EXT-X-TARGETDURATION") ||
                    line.startsWith("#EXT-X-MEDIA-SEQUENCE") ||
                    line.startsWith("#EXT-X-MAP")
            );

            const hasMap = headerLines.some((l) => l.startsWith("#EXT-X-MAP"));
            this.pendingHeader = headerLines.map((l) => {
                if (hasMap && l.startsWith("#EXT-X-VERSION")) return "#EXT-X-VERSION:7";
                if (hasMap && l.startsWith("#EXT-X-MAP")) return '#EXT-X-MAP:URI="init.mp4"';
                return l;
            });

            const seqLine = headerLines.find((l) => l.startsWith("#EXT-X-MEDIA-SEQUENCE"));
            if (seqLine) {
                const seq = parseInt(seqLine.split(":")[1], 10);
                if (!isNaN(seq)) this.startSequence = seq;
            }
        }

        const existingSegments = await this.getExistingLocalSegments();

        for (let i = 0; i < liveLines.length; i++) {
            const line = liveLines[i].trim();
            if (line === "" || line.startsWith("#")) {
                continue;
            }

            const remoteTsUrl = urlResolver(line);

            const tsNameWithQuery = remoteTsUrl.substring(remoteTsUrl.lastIndexOf("/") + 1);
            const localName = tsNameWithQuery.split("?")[0];

            if (!existingSegments.has(localName) && !this.ignoredSegments.has(localName) && !this.seenRemoteUrls.has(remoteTsUrl)) {
                const segmentMetadata: string[] = [];
                for (let j = i - 1; j >= 0; j--) {
                    const metaLine = liveLines[j].trim();
                    if (metaLine.startsWith("#EXTINF")) {
                        segmentMetadata.unshift(metaLine);
                    } else if (metaLine === "#EXT-X-DISCONTINUITY") {
                        segmentMetadata.unshift(metaLine);
                    } else if (metaLine.startsWith("#")) {
                        continue;
                    } else {
                        break;
                    }
                }
                this.seenRemoteUrls.add(remoteTsUrl);
                newSegments.push({ remoteUrl: remoteTsUrl, localName, metadata: segmentMetadata });
            }
        }

        return newSegments;
    }

    /**
     * Buffer a quality change. NOT written to the file immediately.
     * Flushed to the file when the next segment is appended via
     * appendSegmentToPlaylist, which guarantees the header exists first.
     */
    public bufferQualityChange(initSegmentName: string): void {
        this.pendingQualityChanges.push(initSegmentName);
        logger.debug(`[PlaylistManager] Buffered quality change: ${initSegmentName}`);
    }

    public async appendSegmentToPlaylist(segment: SegmentInfo): Promise<void> {
        const currentNumber = parseInt(segment.localName.replace(/\.ts$/, ""), 10);

        if (!isNaN(currentNumber) && this.lastSegmentNumber !== -1 && currentNumber !== this.lastSegmentNumber + 1) {
            await this.insertDiscontinuity();
        }

        if (!isNaN(currentNumber)) {
            this.lastSegmentNumber = currentNumber;
        }

        if (segment.accurateDuration !== undefined && segment.accurateDuration > 0) {
            const idx = segment.metadata.findIndex(l => l.startsWith("#EXTINF:"));
            if (idx !== -1) {
                segment.metadata[idx] = `#EXTINF:${segment.accurateDuration.toFixed(3)},`;
            }
        }

        const segDuration = segment.accurateDuration ?? this.getExtinfDuration(segment.metadata);
        const requiredTarget = Math.ceil(segDuration);

        // Flush header + buffered quality changes atomically on first segment.
        // After this block, pendingHeader is null and the file exists with
        // a valid header followed by any quality change markers.
        if (this.pendingHeader) {
            this.currentTargetDuration = requiredTarget;
            const header = this.pendingHeader.map((l) =>
                l.startsWith("#EXT-X-TARGETDURATION") ? `#EXT-X-TARGETDURATION:${requiredTarget}` : l
            );

            let initialContent = header.map(l => l.trim()).join("\n") + "\n";

            for (const initName of this.pendingQualityChanges) {
                initialContent += `#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="${initName}"\n`;
            }
            this.pendingQualityChanges = [];

            await FileSystemManager.writeFile(this.fullPlaylistPath, initialContent);
            this.pendingHeader = null;
        } else if (this.pendingQualityChanges.length > 0) {
            // Header already written — flush buffered quality changes now.
            for (const initName of this.pendingQualityChanges) {
                const tag = `#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="${initName}"\n`;
                await FileSystemManager.appendFile(this.fullPlaylistPath, tag);
            }
            this.pendingQualityChanges = [];
        }

        if (requiredTarget > this.currentTargetDuration) {
            const content = await FileSystemManager.readFile(this.fullPlaylistPath);
            if (content) {
                const updated = content.replace(
                    /^#EXT-X-TARGETDURATION:\d+$/m,
                    `#EXT-X-TARGETDURATION:${requiredTarget}`
                );
                await FileSystemManager.writeFile(this.fullPlaylistPath, updated);
                this.currentTargetDuration = requiredTarget;
            }
        }

        const entry = [...segment.metadata, segment.localName].join("\n") + "\n";
        await FileSystemManager.appendFile(this.fullPlaylistPath, entry);
    }

    private async insertDiscontinuity(): Promise<void> {
        const tag = "#EXT-X-DISCONTINUITY\n";
        await FileSystemManager.appendFile(this.fullPlaylistPath, tag);
        logger.debug(`[PlaylistManager] Inserted discontinuity tag.`);
    }

    public async finalizePlaylist(): Promise<void> {
        logger.info(`Finalizing playlist: ${this.fullPlaylistPath}`);
        const endTag = "#EXT-X-ENDLIST\n";
        await FileSystemManager.appendFile(this.fullPlaylistPath, endTag);

        const content = await FileSystemManager.readFile(this.fullPlaylistPath);
        if (content) {
            const { content: fixed, wasFixed } = fixTargetDuration(content);
            if (wasFixed) {
                await FileSystemManager.writeFile(this.fullPlaylistPath, fixed);
                logger.info(`[PlaylistManager] Fixed TARGETDURATION in ${this.fullPlaylistPath}`);
            }
        }
    }
}
