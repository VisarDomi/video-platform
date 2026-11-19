// The ground-truth log: an append-only JSON-lines record of everything the
// simulator published (segment availability per channel, edge and rendition)
// and every response it gave. A checker reads it back to compute exactly what
// a client could have fetched, and compares that with what the client kept.
//
// Each record is one write(2) to a file opened O_APPEND, and the file is
// fsynced at most a second after a write. After a power cut the log ends at a
// whole record or a torn last line, which the reader skips.
import { closeSync, fdatasyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export interface ScenarioRecord {
    type: "scenario";
    t: number;
    name: string;
    seed: string;
    hash: string;
    epochMs: number;
    reason: "start" | "switch";
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
}

export class TruthLog implements TruthSink {
    private fd: number | null;
    private dirty = false;
    private readonly timer: NodeJS.Timeout;

    constructor(readonly file: string, flushEveryMs = 1000) {
        mkdirSync(dirname(file), { recursive: true });
        this.fd = openSync(file, "a");
        this.timer = setInterval(() => this.flush(), flushEveryMs);
        this.timer.unref();
    }

    append(record: TruthRecord): void {
        if (this.fd === null) return;
        writeSync(this.fd, JSON.stringify(record) + "\n");
        this.dirty = true;
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
}
