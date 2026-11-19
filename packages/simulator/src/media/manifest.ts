// The media cache's description of one prepared source. Everything the
// servers need (durations, sizes, hashes, dimensions) is here, so serving
// never probes media.
import type { TrackInfo } from "./fmp4.js";

export const MANIFEST_VERSION = 1;

export type SegmentFormat = "ts" | "fmp4";

export interface FileEntry {
    file: string;
    bytes: number;
    sha256: string;
}

export interface SegmentEntry extends FileEntry {
    durationS: number;
}

export interface RenditionManifest {
    id: string;
    format: SegmentFormat;
    /** Directory relative to the source's cache directory. */
    dir: string;
    targetDurationS: number;
    width: number;
    height: number;
    frameRate: number;
    /** RFC 6381 codecs attribute for master playlists. */
    codecs: string;
    /** Peak and average bits per second over the segments. */
    bandwidth: number;
    averageBandwidth: number;
    /** Sum of the segment durations: one pass of the source. */
    loopDurationS: number;
    init?: FileEntry;
    tracks?: TrackInfo[];
    /** MPEG-TS: how far each PID's continuity counter advances per pass. */
    continuitySteps?: Record<string, number>;
    segments: SegmentEntry[];
}

export interface DamageEntry extends FileEntry {
    kind: "single-frame" | "zero-size-sample" | "zero-byte" | "resolution-boundary";
    /** The rendition segment it was derived from. */
    from?: string;
}

export interface SourceManifest {
    version: number;
    id: string;
    input: { file: string; bytes: number; mtimeMs: number };
    params: { minutes: number | null; maxHeight: number };
    videoCopied: boolean;
    renditions: Record<string, RenditionManifest>;
    /**
     * Named rendition sets whose segments line up index by index:
     * ts = [ts, ts-alt], fmp4 = [fmp4, fmp4-alt], ladder = top..bottom.
     */
    groups: Record<string, string[]>;
    damage: DamageEntry[];
}
