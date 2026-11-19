// The ground-truth log: an append-only JSON-lines record of everything the
// simulator published (segment availability per channel, edge and rendition)
// and every response it gave. A checker reads it back to compute exactly what
// a client could have fetched, and compares that with what the client kept.
//
// Each record is one write(2) to a file opened O_APPEND, and the file is
// fsynced at most a second after a write. After a power cut the log ends at a
// whole record or a torn last line, which the reader skips.
//
// Rotation (by size, or by simulated time since the file's first record)
// fsyncs the current file, renames it to <stem>.<n><ext> with the next free
// n, fsyncs the directory and starts a new file; readers take the rotated
// files in order and then the current one. A crash between the rename and
// the first write just leaves no current file yet.
import { closeSync, existsSync, fdatasyncSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fsyncDir } from "../fsutil.js";

export interface ScenarioRecord {
    type: "scenario";
    t: number;
    name: string;
    seed: string;
    hash: string;
    epochMs: number;
    /** "continue" repeats the scenario at the top of a rotated-in file; it starts no new period. */
    reason: "start" | "switch" | "continue";
}

export interface SessionRecord {
    type: "session";
    t: number;
    site: string;
    channel: string;
    session: string;
    index: number;
    startMs: number;
    endMs: number | null;
    recordingId: string;
    source: string;
}

export interface PublishRecord {
    type: "publish";
    t: number;
    site: string;
    channel: string;
    session: string;
    edge: string;
    /** The variant (rendition slot) the segment is listed under. */
    tier: string;
    /** The rendition actually served (differs from the tier during a codec change). */
    rendition: string;
    k: number;
    seq: number;
    pdt: string;
    durationS: number;
    publishedAt: number;
    listedUntil: number | null;
    fetchableUntil: number;
    srcSha256: string;
    srcIndex: number;
    loop: number;
    damage: string | null;
    /** sha256 of the exact bytes served; null when skipped to keep up (see README). */
    sha256: string | null;
    bytes: number | null;
}

export interface ResponseRecord {
    type: "response";
    t: number;
    site: string;
    method: string;
    path: string;
    status: number | "reset";
    kind: string;
    bytes: number;
    sha256?: string;
    channel?: string;
    session?: string;
    edge?: string;
    tier?: string;
    k?: number;
    seq?: number;
    mediaSequence?: number;
    count?: number;
    ended?: boolean;
    stale?: boolean;
    reason?: string;
    /** Streamed bodies: the announced length (`bytes` is what was sent). */
    planned?: number;
    /** Byte range served (file downloads), "first-last". */
    range?: string;
    /** File host: the file id; destinations: the video id. */
    file?: string;
    video?: string;
}

export interface EventRecord {
    type: "event";
    t: number;
    site: string;
    event: string;
    [key: string]: unknown;
}

export type TruthRecord = ScenarioRecord | SessionRecord | PublishRecord | ResponseRecord | EventRecord;

export interface TruthSink {
    append(record: TruthRecord): void;
    close(): void;
    /** Called after the log moved on to a new file (rotation). */
    onRotate?(listener: () => void): void;
}

export interface RotationOptions {
    /** Rotate before a record would make the file larger than this. */
    maxBytes?: number;
    /** Rotate once a record is this much (simulated) time after the file's first record. */
    maxAgeMs?: number;
    /** Keep at most this many rotated files (oldest deleted first). */
    keep?: number;
}

/** The rotated files of a log, oldest first, then the current file (when it exists). */
export function truthFiles(file: string): string[] {
    const dir = dirname(file);
    const ext = extname(file);
    const stem = basename(file, ext);
    const pattern = new RegExp(`^${escapeRe(stem)}\\.(\\d+)${escapeRe(ext)}$`);
    const rotated = existsSync(dir) ? readdirSync(dir).flatMap(name => {
        const m = pattern.exec(name);
        return m ? [{ n: Number(m[1]), path: join(dir, name) }] : [];
    }).sort((a, b) => a.n - b.n).map(x => x.path) : [];
    return existsSync(file) ? [...rotated, file] : rotated;
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function rotatedName(file: string, n: number): string {
    const ext = extname(file);
    return join(dirname(file), `${basename(file, ext)}.${String(n).padStart(6, "0")}${ext}`);
}

/** The `t` of the first whole record in a file (null for an empty one). */
function firstRecordTime(fd: number): number | null {
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const line = buf.subarray(0, n).toString("utf8").split("\n")[0];
    try { return typeof JSON.parse(line).t === "number" ? JSON.parse(line).t : null; } catch { return null; }
}

export class TruthLog implements TruthSink {
    private fd: number | null;
    private dirty = false;
    private size = 0;
    private firstT: number | null = null;
    private readonly timer: NodeJS.Timeout;
    private readonly listeners: Array<() => void> = [];
    private rotating = false;

    constructor(readonly file: string, flushEveryMs = 1000, private readonly rotation: RotationOptions = {}) {
        mkdirSync(dirname(file), { recursive: true });
        this.fd = openSync(file, "a+");
        this.size = fstatSync(this.fd).size;
        if (this.size > 0) this.firstT = firstRecordTime(this.fd);
        this.timer = setInterval(() => this.flush(), flushEveryMs);
        this.timer.unref();
    }

    append(record: TruthRecord): void {
        if (this.fd === null) return;
        const line = JSON.stringify(record) + "\n";
        const bytes = Buffer.byteLength(line);
        if (!this.rotating && this.size > 0 && this.dueForRotation(record.t, bytes)) this.rotate();
        writeSync(this.fd, line);
        this.size += bytes;
        this.firstT ??= record.t;
        this.dirty = true;
    }

    private dueForRotation(t: number, bytes: number): boolean {
        const { maxBytes, maxAgeMs } = this.rotation;
        if (maxBytes !== undefined && this.size + bytes > maxBytes) return true;
        return maxAgeMs !== undefined && this.firstT !== null && t - this.firstT >= maxAgeMs;
    }

    /** Moves the current file aside and starts a new one (durably), then tells listeners. */
    rotate(): void {
        if (this.fd === null) return;
        fdatasyncSync(this.fd);
        closeSync(this.fd);
        this.fd = null;
        const existing = truthFiles(this.file).filter(f => f !== this.file);
        const last = existing.length ? Number(/\.(\d+)(?:\.[^./]*)?$/.exec(existing[existing.length - 1])![1]) : 0;
        renameSync(this.file, rotatedName(this.file, last + 1));
        if (this.rotation.keep !== undefined) {
            const all = [...existing, rotatedName(this.file, last + 1)];
            for (const old of all.slice(0, Math.max(0, all.length - this.rotation.keep))) rmSync(old, { force: true });
        }
        this.fd = openSync(this.file, "a+");
        fsyncDir(dirname(this.file));
        this.size = 0;
        this.firstT = null;
        this.dirty = false;
        this.rotating = true;
        try {
            for (const listener of this.listeners) listener();
        } finally {
            this.rotating = false;
        }
    }

    onRotate(listener: () => void): void {
        this.listeners.push(listener);
    }

    flush(): void {
        if (this.fd === null || !this.dirty) return;
        fdatasyncSync(this.fd);
        this.dirty = false;
    }

    close(): void {
        clearInterval(this.timer);
        if (this.fd === null) return;
        this.flush();
        closeSync(this.fd);
        this.fd = null;
    }
}

/** Keeps records in memory (tests, or a server run without a log file). */
export class MemoryTruth implements TruthSink {
    readonly records: TruthRecord[] = [];
    append(record: TruthRecord): void { this.records.push(record); }
    close(): void { /* nothing to release */ }
}

export class TeeTruth implements TruthSink {
    constructor(private readonly sinks: TruthSink[]) {}
    append(record: TruthRecord): void { for (const s of this.sinks) s.append(record); }
    close(): void { for (const s of this.sinks) s.close(); }
    onRotate(listener: () => void): void { for (const s of this.sinks) s.onRotate?.(listener); }
    flush(): void { for (const s of this.sinks) (s as { flush?: () => void }).flush?.(); }
}
