import * as path from "path";
import { FileSystemManager } from "../../common/fileSystemManager.js";
import logger from "../../common/logger.js";
import { fixTargetDuration } from "shared";
import { DiskSession } from "./diskSession.js";

export interface SegmentInfo {
    remoteUrl: string;
    localName: string;
    metadata: string[];
    accurateDuration?: number;
    programDateTime?: string;
}

export type SegmentUrlResolver = (segmentLine: string) => string;

/**
 * Broadcast timeline metadata extracted from the variant playlist.
 * Owned by PlaylistManager, read-only for the download loop.
 *
 * Used to verify whether different CDN edges serve the same content
 * timeline (same PROGRAM-DATE-TIME range) despite having different
 * MEDIA-SEQUENCE numbers and edge hostnames.
 */
export interface PlaylistTimeline {
    /** CDN edge extracted from the variant URL (e.g. "b-hls-32") */
    edge: string | null;
    /** EXT-X-MEDIA-SEQUENCE from the first playlist fetch */
    mediaSequence: number;
    /** First EXT-X-PROGRAM-DATE-TIME seen in this session */
    firstProgramDateTime: string | null;
    /** Most recent EXT-X-PROGRAM-DATE-TIME seen */
    lastProgramDateTime: string | null;
}

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
    private readonly disk: DiskSession;
    private ignoredSegments: Set<string> = new Set();
    private seenRemoteUrls: Set<string> = new Set();
    private lastSegmentNumber: number = -1;
    public startSequence: number = 0;
    private pendingHeader: string[] | null = null;
    private pendingQualityChanges: string[] = [];
    private currentTargetDuration: number = 0;
    private _timeline: PlaylistTimeline = {
        edge: null,
        mediaSequence: 0,
        firstProgramDateTime: null,
        lastProgramDateTime: null,
    };
    private lastDownloadedPDT: string | null = null;
    private _edgeSwitchActive = false;

    public get timeline(): Readonly<PlaylistTimeline> {
        return this._timeline;
    }

    /**
     * Call when the variant URL changed to a different edge.
     * Enables PDT-based dedup for subsequent segments until
     * we're past the overlap window.
     */
    public onEdgeSwitch(oldEdge: string | null, newEdge: string): void {
        this._edgeSwitchActive = this.lastDownloadedPDT !== null;
        if (this._edgeSwitchActive) {
            logger.info(`[PlaylistManager] Edge switch ${oldEdge ?? "none"} → ${newEdge}, PDT dedup active (lastPDT=${this.lastDownloadedPDT})`);
        }
    }

    /**
     * Check if a segment should be skipped because we already downloaded
     * content covering that broadcast moment from the previous edge.
     * Only active after an edge switch. Logs defensively.
     */
    public shouldSkipByTimeline(segment: SegmentInfo): boolean {
        if (!this._edgeSwitchActive || !segment.programDateTime || !this.lastDownloadedPDT) {
            return false;
        }

        if (segment.programDateTime <= this.lastDownloadedPDT) {
            logger.info(`[PlaylistManager] EDGE-DEDUP skip segment=${segment.localName} pdt=${segment.programDateTime} ≤ lastPDT=${this.lastDownloadedPDT}`);
            return true;
        }

        // First segment past the overlap — dedup window is over.
        const lastDate = new Date(this.lastDownloadedPDT).getTime();
        const segDate = new Date(segment.programDateTime).getTime();
        const gapMs = segDate - lastDate;
        if (gapMs > 4000) {
            logger.warn(`[PlaylistManager] EDGE-GAP ${(gapMs / 1000).toFixed(1)}s between lastPDT=${this.lastDownloadedPDT} and newPDT=${segment.programDateTime}`);
        }
        this._edgeSwitchActive = false;
        return false;
    }

    public recordDownloadedPDT(pdt: string | undefined): void {
        if (pdt) {
            this.lastDownloadedPDT = pdt;
        }
    }

    private get fullPlaylistPath(): string {
        return path.join(this.disk.dirPath, "playlist.m3u8");
    }

    constructor(disk: DiskSession) {
        this.disk = disk;
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
        if (!this.disk.materialized) return new Set();
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

    public setEdge(variantUrl: string): void {
        const edgeMatch = variantUrl.match(/\/(b-hls-\d+)\//);
        if (edgeMatch) {
            this._timeline.edge = edgeMatch[1];
        }
    }

    public async identifyNewSegments(livePlaylistContent: string, urlResolver: SegmentUrlResolver): Promise<SegmentInfo[]> {
        const liveLines = livePlaylistContent.split("\n");
        const newSegments: SegmentInfo[] = [];

        // Extract PROGRAM-DATE-TIME values from this playlist fetch.
        // The last one corresponds to the most recent segment in the playlist.
        for (const line of liveLines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
                const pdt = trimmed.slice("#EXT-X-PROGRAM-DATE-TIME:".length);
                if (!this._timeline.firstProgramDateTime) {
                    this._timeline.firstProgramDateTime = pdt;
                }
                this._timeline.lastProgramDateTime = pdt;
            }
        }

        const fileExists = this.disk.materialized && await FileSystemManager.pathExists(this.fullPlaylistPath);

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
                if (!isNaN(seq)) {
                    this.startSequence = seq;
                    this._timeline.mediaSequence = seq;
                }
            }
        }

        const existingSegments = await this.getExistingLocalSegments();

        let currentPDT: string | null = null;

        for (let i = 0; i < liveLines.length; i++) {
            const line = liveLines[i].trim();
            if (line === "") continue;

            if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
                currentPDT = line.slice("#EXT-X-PROGRAM-DATE-TIME:".length);
                continue;
            }

            if (line.startsWith("#")) {
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
                newSegments.push({ remoteUrl: remoteTsUrl, localName, metadata: segmentMetadata, programDateTime: currentPDT ?? undefined });
            }

            currentPDT = null;
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
