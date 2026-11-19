// Reading the ground-truth log back: which segments were available on which
// edge, and when. This is what a checker compares a client's recording with.
import { readFileSync } from "node:fs";
import type { PublishRecord, ResponseRecord, ScenarioRecord, SessionRecord, TruthRecord } from "./log.js";

export function parseTruth(text: string): { records: TruthRecord[]; skipped: number } {
    const records: TruthRecord[] = [];
    let skipped = 0;
    for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try { records.push(JSON.parse(line)); } catch { skipped++; }
    }
    return { records, skipped };
}

/** Reads a log file. A torn final line (a power cut mid-write) is skipped. */
export function readTruthFile(file: string): TruthRecord[] {
    return parseTruth(readFileSync(file, "utf8")).records;
}

export interface Interval { from: number; until: number }

export interface Availability {
    site: string;
    channel: string;
    session: string;
    edge: string;
    tier: string;
    rendition: string;
    k: number;
    seq: number;
    pdt: string;
    durationS: number;
    damage: string | null;
    sha256: string | null;
    srcSha256: string;
    /** When playlists on this edge listed it (stale caches aside). */
    listed: Interval;
    /** When a request for it would have succeeded, faults aside. */
    fetchable: Interval;
}

export interface SegmentFilter {
    site?: string;
    channel?: string;
    session?: string;
    edge?: string;
    tier?: string;
    /** Keep segments whose listing overlaps [from, to). */
    from?: number;
    to?: number;
}

export interface ResponseFilter {
    site?: string;
    kind?: string;
    channel?: string;
    edge?: string;
    status?: number | "reset";
    from?: number;
    to?: number;
}

const matches = (r: object, f: object, keys: string[]) =>
    keys.every(k => (f as any)[k] === undefined || (r as any)[k] === (f as any)[k]);

export class TruthIndex {
    readonly scenarios: ScenarioRecord[] = [];
    readonly sessionRecords: SessionRecord[] = [];
    readonly responseRecords: ResponseRecord[] = [];
    private readonly segments: Availability[] = [];

    constructor(records: TruthRecord[]) {
        // A scenario record starts a period (in file order): what came before
        // stops being served at its time, and what follows belongs to it.
        const periodEnds: number[] = new Array(records.length).fill(Infinity);
        let nextStart = Infinity;
        for (let i = records.length - 1; i >= 0; i--) {
            periodEnds[i] = nextStart;
            if (records[i].type === "scenario") nextStart = records[i].t;
        }
        let start = -Infinity;
        const seen = new Set<string>();
        records.forEach((r, i) => {
            if (r.type === "scenario") { this.scenarios.push(r); start = r.t; return; }
            if (r.type === "session") { this.sessionRecords.push(r); return; }
            if (r.type === "response") { this.responseRecords.push(r); return; }
            if (r.type !== "publish") return;
            const p = r as PublishRecord;
            const id = `${p.site}/${p.channel}/${p.session}/${p.edge}/${p.tier}/${p.k}/${start}`;
            if (seen.has(id)) return;
            seen.add(id);
            const end = periodEnds[i];
            const listedUntil = p.listedUntil ?? Infinity;
            this.segments.push({
                site: p.site, channel: p.channel, session: p.session, edge: p.edge, tier: p.tier, rendition: p.rendition,
                k: p.k, seq: p.seq, pdt: p.pdt, durationS: p.durationS, damage: p.damage, sha256: p.sha256, srcSha256: p.srcSha256,
                listed: { from: Math.max(p.publishedAt, start), until: Math.min(listedUntil, end) },
                fetchable: { from: Math.max(p.publishedAt, start), until: Math.min(p.fetchableUntil, end) },
            });
        });
        this.segments.sort((a, b) =>
            a.site.localeCompare(b.site) || a.channel.localeCompare(b.channel) || a.session.localeCompare(b.session)
            || a.edge.localeCompare(b.edge) || a.tier.localeCompare(b.tier) || a.k - b.k);
    }

    static fromFile(file: string): TruthIndex {
        return new TruthIndex(readTruthFile(file));
    }

    sessions(filter: { site?: string; channel?: string } = {}): SessionRecord[] {
        return this.sessionRecords.filter(s => matches(s, filter, ["site", "channel"]));
    }

    /** Segments available under the filter, ordered by channel, session, edge, tier and position. */
    available(filter: SegmentFilter = {}): Availability[] {
        const from = filter.from ?? -Infinity, to = filter.to ?? Infinity;
        return this.segments.filter(s => matches(s, filter, ["site", "channel", "session", "edge", "tier"])
            && s.listed.from < to && s.listed.until > from && s.listed.until > s.listed.from);
    }

    /** What a playlist on that edge listed at instant `t`. */
    listedAt(filter: Omit<SegmentFilter, "from" | "to">, t: number): Availability[] {
        return this.segments.filter(s => matches(s, filter, ["site", "channel", "session", "edge", "tier"])
            && s.listed.from <= t && t < s.listed.until);
    }

    /** Segments a request at `t` could have fetched (before request-time faults). */
    fetchableAt(filter: Omit<SegmentFilter, "from" | "to">, t: number): Availability[] {
        return this.segments.filter(s => matches(s, filter, ["site", "channel", "session", "edge", "tier"])
            && s.fetchable.from <= t && t < s.fetchable.until);
    }

    responses(filter: ResponseFilter = {}): ResponseRecord[] {
        return this.responseRecords.filter(r => matches(r, filter, ["site", "kind", "channel", "edge", "status"])
            && (filter.from === undefined || r.t >= filter.from) && (filter.to === undefined || r.t < filter.to));
    }

    /**
     * Sequence numbers that were never published within the session's range
     * on an edge: provider skips (a checker must not blame the client).
     */
    sequenceHoles(filter: { site: string; channel: string; session: string; edge: string; tier: string }): number[] {
        const segs = this.available(filter);
        const holes: number[] = [];
        for (let i = 1; i < segs.length; i++) {
            const prev = segs[i - 1], cur = segs[i];
            if (cur.k === prev.k + 1 || cur.seq <= prev.seq) continue; // contiguous, or a numbering restart
            for (let s = prev.seq + 1; s < cur.seq; s++) holes.push(s);
        }
        return holes;
    }
}
