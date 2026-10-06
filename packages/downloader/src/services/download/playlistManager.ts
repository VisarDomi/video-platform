import * as path from "path";
import { promises as fs } from "fs";
import { fixTargetDuration } from "shared";
import { FileSystemManager } from "../../common/fileSystemManager.js";
import logger from "../../common/logger.js";
import { DiskSession } from "./diskSession.js";
import type { SegmentDimensions } from "./segmentDimensions.js";
import type { SegmentValidationResult } from "../core/interfaces.js";
import {
    type CompoundSegmentIdentity,
    formatSegmentName,
    parseCompoundSegmentName,
} from "./segmentIdentity.js";

// Provider numbering restart rule. A fetched window is a restart when its
// newest provider sequence lies more than (window length + this margin) below
// the committed baseline.
//
// Within one numbering the live edge never moves backwards: a normal poll
// re-lists already-saved segments, but its newest entry is at or above the
// baseline. A window entirely below the baseline is either (a) a stale CDN
// copy or lagging edge of the SAME numbering, whose newest entry lags by at
// most about one window plus a few segments of cache age, or (b) a NEW
// numbering (SC edges number independently, Tango restarts at 0, FC2 went
// 1112 -> 1), which lands far below. One window plus 10 segments (10-20 s of
// cache age at 1-2 s segments) covers (a); anything further below is (b) and
// is accepted as new media. A restart that lands within the margin is still
// deduplicated against the old numbering (bounded by the margin).
export const SEQUENCE_RESTART_MARGIN_SEGMENTS = 10;

// A segment re-listed after an edge switch is a duplicate only when its
// program date-time is not newer than the last saved one AND within this
// horizon of it. No live window re-lists media older than this, so a larger
// difference is clock skew between edges, never overlap, and must not swallow
// new media.
export const EDGE_DEDUP_MAX_OVERLAP_MS = 60_000;

export type SegmentInspector = (filePath: string) => Promise<SegmentValidationResult>;

const INIT_FILE_NAME = /^init(?:_(\d+)(?:_(\d+))?)?\.mp4$/;

function initFileOrder(name: string): [number, number] | null {
    const match = name.match(INIT_FILE_NAME);
    if (!match) return null;
    return match[1] === undefined ? [-1, 0] : [Number(match[1]), Number(match[2] ?? 0)];
}

export interface SegmentInfo {
    remoteUrl: string;
    localName: string;
    providerSequence: number;
    metadata: string[];
    accurateDuration?: number;
    dimensions?: SegmentDimensions | null;
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
    private lastDimensions: SegmentDimensions | null | undefined;
    // Provider sequence of the last handled segment of the CURRENT numbering
    // run (committed, or abandoned as empty). Only later sequences are new
    // media unless the window proves a numbering restart. It is a baseline,
    // not a maximum: a restart lowers it to the new run.
    private baselineProviderSequence: number | null = null;
    private readonly rejectedAttempts = new Map<number, number>();
    private nextLocalNumber = 0;
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
    private lastPollAt: number | null = null;
    private _missedSegmentCount = 0;

    // Provider segments that left the live window before a poll listed them.
    public get missedSegmentCount(): number {
        return this._missedSegmentCount;
    }

    public get timeline(): Readonly<PlaylistTimeline> {
        return this._timeline;
    }

    public onEdgeSwitch(oldEdge: string | null, newEdge: string): void {
        this._edgeSwitchActive = this.lastDownloadedPDT !== null;
        if (this._edgeSwitchActive) {
            logger.debug(`[PlaylistManager] Edge switch ${oldEdge ?? "none"} → ${newEdge}, PDT dedup active (lastPDT=${this.lastDownloadedPDT})`);
        }
    }

    public shouldSkipByTimeline(segment: SegmentInfo): boolean {
        if (!this._edgeSwitchActive || !segment.programDateTime || !this.lastDownloadedPDT) {
            return false;
        }

        // Compare instants, not strings: edges may format the same instant
        // differently (+0000 vs Z, with or without milliseconds).
        const lastDate = Date.parse(this.lastDownloadedPDT);
        const segDate = Date.parse(segment.programDateTime);
        if (!Number.isFinite(lastDate) || !Number.isFinite(segDate)) {
            return false;
        }
        const gapMs = segDate - lastDate;
        if (gapMs <= 0 && -gapMs <= EDGE_DEDUP_MAX_OVERLAP_MS) {
            logger.debug(`[PlaylistManager] EDGE-DEDUP skip segment=${segment.localName} pdt=${segment.programDateTime} ≤ lastPDT=${this.lastDownloadedPDT}`);
            return true;
        }
        if (gapMs <= 0) {
            logger.warn(`[PlaylistManager] EDGE-DEDUP bypassed: segment=${segment.localName} pdt=${segment.programDateTime} is ${(-gapMs / 1000).toFixed(1)}s before lastPDT=${this.lastDownloadedPDT}, beyond any live overlap; treating as new media (edge clock skew)`);
        } else if (gapMs > 4000) {
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

    public async initializeFromExistingPlaylist(inspectSegment?: SegmentInspector): Promise<void> {
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
            // Without a playlist header there is nowhere to append them; the
            // files stay on disk and finalization lists them as unreferenced.
            logger.warn(`[PlaylistManager] Resuming after a first-segment power loss recording=${this.recordingId} nextLocal=${this.nextLocalNumber} unreferencedMedia=${diskIdentities.length} (kept on disk)`);
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
        // The baseline is the TAIL, not the maximum: a provider numbering
        // restart committed before this process stopped must not make the
        // continuing new run look like already-saved media again.
        this.baselineProviderSequence = parsed.at(-1)?.providerSequence ?? null;
        this.lastProviderSequence = parsed.at(-1)?.providerSequence ?? null;
        this.resumeDiscontinuityPending = parsed.length > 0;
        this.pendingHeader = null;

        const targetDuration = recoveredContent.match(/^#EXT-X-TARGETDURATION:(\d+)$/m);
        this.currentTargetDuration = targetDuration ? Number.parseInt(targetDuration[1], 10) : 0;

        const reappended = parsed.length > 0
            ? await this.reappendUnreferencedTail(recoveredContent, diskNames, parsed.at(-1)!.localNumber, inspectSegment)
            : [];
        const referencedCount = parsed.length + reappended.length;
        logger.debug(`[PlaylistManager] Resume initialized recording=${this.recordingId} nextLocal=${this.nextLocalNumber} baselineProviderSequence=${this.baselineProviderSequence ?? "none"} reappendedMedia=${reappended.length} unreferencedMedia=${Math.max(0, diskIdentities.length - referencedCount)}`);
    }

    // A crash between writing a segment file and appending its playlist entry
    // (or a torn append) leaves real media that the playlist does not
    // reference. Files written AFTER the committed tail are re-appended in
    // write (local-number) order before live capture resumes, so the live
    // window then deduplicates against them. Anything else that is
    // unreferenced stays on disk untouched for finalization to report.
    private async reappendUnreferencedTail(
        playlist: string,
        diskNames: readonly string[],
        tailLocalNumber: number,
        inspectSegment?: SegmentInspector,
    ): Promise<string[]> {
        const referenced = new Set(playlist.split(/\r?\n/).map((line) => line.trim()));
        const candidates = diskNames
            .map((name) => ({ name, identity: parseCompoundSegmentName(name) }))
            .filter((candidate): candidate is { name: string; identity: CompoundSegmentIdentity } =>
                candidate.identity !== null
                && candidate.identity.recordingId === this.recordingId
                && candidate.identity.localNumber > tailLocalNumber
                && !referenced.has(candidate.name))
            .sort((left, right) => left.identity.localNumber - right.identity.localNumber);
        if (candidates.length === 0) return [];

        let activeMap = [...playlist.matchAll(/^#EXT-X-MAP:.*\bURI="([^"]+)"/gm)].at(-1)?.[1] ?? null;
        const initFiles = diskNames
            .map((name) => ({ name, order: initFileOrder(name) }))
            .filter((file): file is { name: string; order: [number, number] } => file.order !== null)
            .sort((left, right) => left.order[0] - right.order[0] || left.order[1] - right.order[1]);
        const provisionalDuration = Number.parseFloat(
            [...playlist.matchAll(/^#EXTINF:([\d.]+)/gm)].at(-1)?.[1] ?? "",
        ) || this.currentTargetDuration || 1;

        // These files continue the committed capture; ordinary sequence-gap,
        // geometry, and map rules decide their boundaries.
        this.resumeDiscontinuityPending = false;
        const reappended: string[] = [];
        for (const { name, identity } of candidates) {
            const filePath = path.join(this.disk.dirPath, name);
            const size = await fs.stat(filePath).then((stats) => stats.isFile() ? stats.size : 0, () => 0);
            const inspection: SegmentValidationResult = size === 0
                ? { valid: false }
                : inspectSegment ? await inspectSegment(filePath) : { valid: true };
            if (!inspection.valid) {
                logger.warn(`[PlaylistManager] Unreferenced media after the tail is empty or unreadable; kept on disk, not re-appended: ${name}`);
                continue;
            }
            if (identity.providerSequence === this.lastProviderSequence) {
                logger.warn(`[PlaylistManager] Unreferenced media repeats the previous provider sequence; kept on disk, not re-appended: ${name}`);
                continue;
            }
            if (activeMap !== null) {
                // An init map applies to every segment identified after it was
                // committed; init names carry the next local number at commit.
                const applicable = initFiles.filter((file) => file.order[0] <= identity.localNumber).at(-1)?.name;
                if (!applicable) {
                    logger.warn(`[PlaylistManager] Unreferenced fragment has no initialization map on disk; kept on disk, not re-appended: ${name}`);
                    continue;
                }
                if (applicable !== activeMap) {
                    this.bufferQualityChange(applicable);
                    activeMap = applicable;
                }
            }
            const duration = inspection.duration !== undefined && inspection.duration > 0
                ? inspection.duration
                : provisionalDuration;
            await this.appendSegmentToPlaylist({
                remoteUrl: "",
                localName: name,
                providerSequence: identity.providerSequence,
                metadata: [`#EXTINF:${duration.toFixed(3)},`],
                accurateDuration: inspection.duration,
                dimensions: inspection.dimensions,
            });
            reappended.push(name);
            logger.warn(`[PlaylistManager] Re-appended media written after the playlist tail before an interruption: ${name}`);
        }
        // Live capture after the interruption still starts a new boundary.
        this.resumeDiscontinuityPending = true;
        return reappended;
    }

    private getExtinfDuration(metadata: string[]): number {
        const extinf = metadata.find((l) => l.startsWith("#EXTINF:"));
        if (extinf) {
            const val = parseFloat(extinf.slice("#EXTINF:".length).replace(",", ""));
            if (!isNaN(val)) return val;
        }
        return 2;
    }

    // A rejected (empty or unreadable) download is NOT handled: the next poll
    // fetches it again while the live window still lists it. Returns how many
    // times this sequence was rejected since the last committed segment.
    public noteRejectedSegment(providerSequence: number): number {
        const attempts = (this.rejectedAttempts.get(providerSequence) ?? 0) + 1;
        this.rejectedAttempts.set(providerSequence, attempts);
        return attempts;
    }

    // Gives up on a sequence that kept arriving without media, so a window that
    // no longer moves (ENDLIST, stalled edge) cannot block later segments. It
    // carries no media; the next committed segment gets a sequence-gap boundary.
    public abandonRejectedSegment(providerSequence: number): void {
        this.rejectedAttempts.delete(providerSequence);
        this.baselineProviderSequence = providerSequence;
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

        const windowLength = liveLines.filter((line) => line.trim() !== "" && !line.trim().startsWith("#")).length;
        const windowFirst = this._timeline.mediaSequence;
        const windowLast = windowFirst + windowLength - 1;
        const baseline = this.baselineProviderSequence;
        const restartMargin = windowLength + SEQUENCE_RESTART_MARGIN_SEGMENTS;
        const numberingRestarted = baseline !== null && windowLength > 0 && windowLast < baseline - restartMargin;
        const polledAt = Date.now();
        const sincePreviousPoll = this.lastPollAt === null ? null : (polledAt - this.lastPollAt) / 1000;
        this.lastPollAt = polledAt;
        // The window starts after the next expected segment: media between the two
        // was never listed to us. Either the provider skipped it (a stall at the
        // source) or this loop polled too late (a slow fetch held the previous
        // batch); the time since the previous poll tells which. After an edge
        // switch the numbering is the new edge's, and EDGE-GAP judges by PDT.
        if (baseline !== null && !numberingRestarted && !this._edgeSwitchActive
            && windowLength > 0 && windowFirst > baseline + 1) {
            const missed = windowFirst - baseline - 1;
            this._missedSegmentCount += missed;
            logger.warn(`[PlaylistManager] SEQUENCE-GAP recording=${this.recordingId} missing=${baseline + 1}-${windowFirst - 1} (${missed} segments) window=${windowFirst}-${windowLast} sincePreviousPoll=${sincePreviousPoll === null ? "none" : `${sincePreviousPoll.toFixed(1)}s`}: these segments left the live window before this poll`);
        }
        if (numberingRestarted) {
            logger.warn(`[PlaylistManager] SEQUENCE-RESTART recording=${this.recordingId} edge=${this._timeline.edge ?? "unknown"} previous=${baseline} window=${windowFirst}-${windowLast} margin=${restartMargin}: provider restarted its numbering; accepting the window as new media after a discontinuity`);
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

            if (numberingRestarted || baseline === null || providerSequence > baseline) {
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
                if (numberingRestarted && newSegments.length === 0
                    && !segmentMetadata.includes("#EXT-X-DISCONTINUITY")) {
                    segmentMetadata.unshift("#EXT-X-DISCONTINUITY");
                }
                newSegments.push({
                    remoteUrl: remoteTsUrl,
                    localName: formatSegmentName(this.nextLocalNumber++, this.recordingId, providerSequence),
                    providerSequence,
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
        if (boundaryAlreadyBuffered) {
            // The buffered MAP already supplies this segment's discontinuity.
            segment.metadata = segment.metadata.filter((line) => line !== "#EXT-X-DISCONTINUITY");
        }
        const geometryChanged = this.lastProviderSequence !== null
            && segment.dimensions !== undefined
            && (segment.dimensions === null || this.lastDimensions == null
                || segment.dimensions.width !== this.lastDimensions.width
                || segment.dimensions.height !== this.lastDimensions.height
                || segment.dimensions.sampleAspectRatio !== this.lastDimensions.sampleAspectRatio);
        if ((this.resumeDiscontinuityPending || sequenceBreak || geometryChanged)
            && !boundaryAlreadyBuffered
            && !segment.metadata.includes("#EXT-X-DISCONTINUITY")) {
            segment.metadata.unshift("#EXT-X-DISCONTINUITY");
        }

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
        // Only accepted, committed media advances the dimension baseline.
        this.resumeDiscontinuityPending = false;
        this.lastProviderSequence = segment.providerSequence;
        this.lastDimensions = segment.dimensions;
        // Set, not max: within one numbering run commits only increase, and
        // the first commit after a numbering restart lowers the baseline.
        this.baselineProviderSequence = segment.providerSequence;
        this.rejectedAttempts.clear();
    }

    public async finalizePlaylist(): Promise<void> {
        logger.debug(`Finalizing playlist: ${this.fullPlaylistPath}`);
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
        if (wasFixed) logger.debug(`[PlaylistManager] Fixed TARGETDURATION in ${this.fullPlaylistPath}`);
    }
}
