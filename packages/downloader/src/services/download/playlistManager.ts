import * as path from "path";
import { promises as fs } from "fs";
import { fixTargetDuration } from "shared";
import { FileSystemManager } from "../../common/fileSystemManager.js";
import logger from "../../common/logger.js";
import { DiskSession } from "./diskSession.js";
import {
    formatSegmentName,
    parseCompoundSegmentName,
    providerSegmentKey,
    RECOVERY_DEDUP_TAIL_SIZE,
} from "./segmentIdentity.js";

export interface SegmentInfo {
    remoteUrl: string;
    localName: string;
    providerSequence: number;
    identityKey: string;
    metadata: string[];
    accurateDuration?: number;
    programDateTime?: string;
}

export type SegmentUrlResolver = (segmentLine: string) => string;

export interface PlaylistTimeline {
    edge: string | null;
    mediaSequence: number;
    firstProgramDateTime: string | null;
    lastProgramDateTime: string | null;
}

export class PlaylistManager {
    private readonly disk: DiskSession;
    private lastProviderSequence: number | null = null;
    private nextLocalNumber = 0;
    private recentProviderKeys: string[] = [];
    private recentProviderKeySet = new Set<string>();
    private resumeDiscontinuityPending = false;
    private readonly recordingId: string;
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

    public onEdgeSwitch(oldEdge: string | null, newEdge: string): void {
        this._edgeSwitchActive = this.lastDownloadedPDT !== null;
        if (this._edgeSwitchActive) {
            logger.info(`[PlaylistManager] Edge switch ${oldEdge ?? "none"} → ${newEdge}, PDT dedup active (lastPDT=${this.lastDownloadedPDT})`);
        }
    }

    public shouldSkipByTimeline(segment: SegmentInfo): boolean {
        if (!this._edgeSwitchActive || !segment.programDateTime || !this.lastDownloadedPDT) {
            return false;
        }

        if (segment.programDateTime <= this.lastDownloadedPDT) {
            logger.info(`[PlaylistManager] EDGE-DEDUP skip segment=${segment.localName} pdt=${segment.programDateTime} ≤ lastPDT=${this.lastDownloadedPDT}`);
            return true;
        }

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

    constructor(disk: DiskSession, recordingId: string) {
        this.disk = disk;
        this.recordingId = recordingId;
    }

    public get nextSegmentNumber(): number {
        return this.nextLocalNumber;
    }

    public async initializeFromExistingPlaylist(): Promise<void> {
        if (!this.disk.materialized) return;
        const content = await FileSystemManager.readFile(this.fullPlaylistPath);
        const diskNames = await fs.readdir(this.disk.dirPath);
        const diskIdentities = diskNames
            .map((name) => parseCompoundSegmentName(name))
            .filter((identity): identity is NonNullable<typeof identity> => identity !== null);
        if (diskIdentities.some((identity) => identity.recordingId !== this.recordingId)) {
            throw new Error(`Recording identity mismatch in media files at ${this.disk.dirPath}`);
        }
        if (!content) {
            this.nextLocalNumber = diskIdentities.reduce(
                (maximum, identity) => Math.max(maximum, identity.localNumber + 1),
                0,
            );
            logger.warn(`[PlaylistManager] Resuming after a first-segment power loss recording=${this.recordingId} nextLocal=${this.nextLocalNumber} unreferencedMedia=${diskIdentities.length}`);
            return;
        }

        const sanitizedContent = content.replaceAll("\0", "");
        const lines = sanitizedContent.split(/\r?\n/);
        let lastValidSegmentLine = -1;
        let firstInvalidMediaLine = -1;
        for (let index = 0; index < lines.length; index++) {
            const line = lines[index].trim();
            if (line === "" || line.startsWith("#")) continue;
            const identity = parseCompoundSegmentName(line);
            if (identity && identity.recordingId === this.recordingId) {
                lastValidSegmentLine = index;
            } else if (firstInvalidMediaLine === -1) {
                firstInvalidMediaLine = index;
            }
        }
        if (firstInvalidMediaLine !== -1 && firstInvalidMediaLine <= lastValidSegmentLine) {
            throw new Error(`Cannot resume legacy, mixed-name, or internally corrupt playlist at ${this.fullPlaylistPath}`);
        }

        const recoveredContent = lastValidSegmentLine >= 0
            ? lines.slice(0, lastValidSegmentLine + 1).join("\n") + "\n"
            : sanitizedContent;
        if (recoveredContent !== content) {
            if (!await FileSystemManager.writeFileAtomic(this.fullPlaylistPath, recoveredContent)) {
                throw new Error(`Could not atomically recover active playlist tail at ${this.fullPlaylistPath}`);
            }
            logger.warn(`[PlaylistManager] Recovered incomplete playlist tail at ${this.fullPlaylistPath}`);
        }

        const segmentNames = recoveredContent.split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line !== "" && !line.startsWith("#"));
        const parsed = segmentNames
            .map((name) => parseCompoundSegmentName(name))
            .filter((identity): identity is NonNullable<typeof identity> => identity !== null);

        if (segmentNames.length > 0 && parsed.length !== segmentNames.length) {
            throw new Error(`Cannot resume legacy or mixed-name playlist at ${this.fullPlaylistPath}`);
        }
        if (parsed.some((identity) => identity.recordingId !== this.recordingId)) {
            throw new Error(`Recording identity mismatch in ${this.fullPlaylistPath}`);
        }

        this.nextLocalNumber = diskIdentities.reduce(
            (maximum, identity) => Math.max(maximum, identity.localNumber + 1),
            parsed.reduce((maximum, identity) => Math.max(maximum, identity.localNumber + 1), 0),
        );
        const tail = parsed.slice(-RECOVERY_DEDUP_TAIL_SIZE);
        for (const identity of tail) this.rememberProviderKey(providerSegmentKey(identity));
        this.lastProviderSequence = tail.at(-1)?.providerSequence ?? null;
        this.resumeDiscontinuityPending = parsed.length > 0;
        this.pendingHeader = null;

        const targetDuration = recoveredContent.match(/^#EXT-X-TARGETDURATION:(\d+)$/m);
        this.currentTargetDuration = targetDuration ? Number.parseInt(targetDuration[1], 10) : 0;
        logger.info(`[PlaylistManager] Resume initialized recording=${this.recordingId} nextLocal=${this.nextLocalNumber} dedupTail=${tail.length} unreferencedMedia=${Math.max(0, diskIdentities.length - parsed.length)}`);
    }

    private rememberProviderKey(key: string): void {
        if (this.recentProviderKeySet.has(key)) return;
        this.recentProviderKeys.push(key);
        this.recentProviderKeySet.add(key);
        while (this.recentProviderKeys.length > RECOVERY_DEDUP_TAIL_SIZE) {
            const removed = this.recentProviderKeys.shift();
            if (removed !== undefined) this.recentProviderKeySet.delete(removed);
        }
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
        this.rememberProviderKey(segmentName);
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

        const sequenceLine = liveLines.find((line) => line.trim().startsWith("#EXT-X-MEDIA-SEQUENCE:"));
        if (sequenceLine) {
            const sequence = Number.parseInt(sequenceLine.split(":")[1], 10);
            if (Number.isSafeInteger(sequence)) this._timeline.mediaSequence = sequence;
        }

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

        let currentPDT: string | null = null;
        let segmentOffset = 0;

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
            const providerSequence = this._timeline.mediaSequence + segmentOffset;
            segmentOffset++;
            const identityKey = providerSegmentKey({ recordingId: this.recordingId, providerSequence });

            if (!this.recentProviderKeySet.has(identityKey)) {
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
                newSegments.push({
                    remoteUrl: remoteTsUrl,
                    localName: formatSegmentName(this.nextLocalNumber++, this.recordingId, providerSequence),
                    providerSequence,
                    identityKey,
                    metadata: segmentMetadata,
                    programDateTime: currentPDT ?? undefined,
                });
            }

            currentPDT = null;
        }

        return newSegments;
    }

    public bufferQualityChange(initSegmentName: string): void {
        this.pendingQualityChanges.push(initSegmentName);
        logger.debug(`[PlaylistManager] Buffered quality change: ${initSegmentName}`);
    }

    public async appendSegmentToPlaylist(segment: SegmentInfo): Promise<void> {
        const sequenceBreak = this.lastProviderSequence !== null
            && segment.providerSequence !== this.lastProviderSequence + 1;
        const boundaryAlreadyBuffered = this.pendingQualityChanges.length > 0;
        if ((this.resumeDiscontinuityPending || sequenceBreak)
            && !boundaryAlreadyBuffered
            && !segment.metadata.includes("#EXT-X-DISCONTINUITY")) {
            segment.metadata.unshift("#EXT-X-DISCONTINUITY");
        }
        this.resumeDiscontinuityPending = false;
        this.lastProviderSequence = segment.providerSequence;

        if (segment.accurateDuration !== undefined && segment.accurateDuration > 0) {
            const idx = segment.metadata.findIndex(l => l.startsWith("#EXTINF:"));
            if (idx !== -1) {
                segment.metadata[idx] = `#EXTINF:${segment.accurateDuration.toFixed(3)},`;
            }
        }

        const segDuration = segment.accurateDuration ?? this.getExtinfDuration(segment.metadata);
        const requiredTarget = Math.ceil(segDuration);

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

            if (!await FileSystemManager.writeFileAtomic(this.fullPlaylistPath, initialContent)) {
                throw new Error(`Could not atomically create ${this.fullPlaylistPath}`);
            }
            this.pendingHeader = null;
        } else if (this.pendingQualityChanges.length > 0) {
            for (const initName of this.pendingQualityChanges) {
                const tag = `#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="${initName}"\n`;
                if (!await FileSystemManager.appendFile(this.fullPlaylistPath, tag)) {
                    throw new Error(`Could not append init boundary to ${this.fullPlaylistPath}`);
                }
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
                if (!await FileSystemManager.writeFileAtomic(this.fullPlaylistPath, updated)) {
                    throw new Error(`Could not atomically update TARGETDURATION in ${this.fullPlaylistPath}`);
                }
                this.currentTargetDuration = requiredTarget;
            }
        }

        const entry = [...segment.metadata, segment.localName].join("\n") + "\n";
        if (!await FileSystemManager.appendFile(this.fullPlaylistPath, entry)) {
            throw new Error(`Could not append segment to ${this.fullPlaylistPath}`);
        }
        this.rememberProviderKey(segment.identityKey);
    }

    public async finalizePlaylist(): Promise<void> {
        logger.info(`Finalizing playlist: ${this.fullPlaylistPath}`);
        const content = await FileSystemManager.readFile(this.fullPlaylistPath);
        if (!content) throw new Error(`Cannot finalize recording without playlist: ${this.fullPlaylistPath}`);
        const withoutEndlist = content.split(/\r?\n/)
            .filter((line) => line.trim() !== "#EXT-X-ENDLIST")
            .join("\n")
            .replace(/\n*$/, "\n");
        const withEndlist = `${withoutEndlist}#EXT-X-ENDLIST\n`;
        const { content: fixed, wasFixed } = fixTargetDuration(withEndlist);
        const written = await FileSystemManager.writeFileAtomic(this.fullPlaylistPath, fixed);
        if (!written) throw new Error(`Could not atomically finalize ${this.fullPlaylistPath}`);
        if (wasFixed) logger.info(`[PlaylistManager] Fixed TARGETDURATION in ${this.fullPlaylistPath}`);
    }
}
