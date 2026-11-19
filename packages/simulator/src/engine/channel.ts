// One simulated channel: when it is live, and what each of its edges lists
// and serves at any instant. Everything is a pure function of the scenario,
// the seed and the time asked about, so a restart (or two servers) agree.
//
// Segment k of a session is the k-th segment of the source after the
// session's start position, looping. It starts at session start + the
// summed durations before it, is complete one duration later, and appears on
// an edge `lagMs` after that.
import type { MediaLibrary } from "../media/library.js";
import type { RenditionManifest } from "../media/manifest.js";
import { hashHex, intBetween, unit } from "../rng.js";
import type { ChannelFault, ChannelSpec, DamageKind, EdgeSpec, SiteId } from "../scenario/schema.js";

export interface Session {
    index: number;
    startMs: number;
    /** null while open-ended. */
    endMs: number | null;
    /** Stable opaque identity of the session (used in URLs). */
    key: string;
}

export interface Edge {
    id: string;
    lagMs: number;
    pdtSkewMs: number;
    firstSequence?: number;
}

export interface WindowEntry {
    k: number;
    seq: number;
    pdtMs: number;
    durationS: number;
    /** Rendition index within the group actually served (codec changes move it). */
    rendition: number;
    srcIndex: number;
    loop: number;
    damage: DamageKind | null;
}

export interface PlaylistWindow {
    session: Session;
    edge: Edge;
    entries: WindowEntry[];
    mediaSequence: number;
    /** The final segment is listed: the playlist carries ENDLIST. */
    ended: boolean;
    /** Past the ENDLIST grace: the site answers with its "gone" response. */
    gone: boolean;
    /** Served from a stale cache: the instant whose window this is. */
    staleAt: number | null;
}

interface ResolvedFault {
    fault: ChannelFault;
    index: number;
    fromMs: number;
    untilMs: number;
}

const LOOKBACK_MS = 6 * 3600 * 1000;
const US = 1000; // microseconds per millisecond

export class ChannelModel {
    readonly renditions: RenditionManifest[];
    readonly edges: Edge[];
    readonly windowSize: number;
    readonly endlistMs: number;
    private readonly durUs: number[];
    private readonly cumUs: number[];
    private readonly loopUs: number;
    private readonly keyCache = new Map<number, string>();
    private readonly faultCache = new Map<number, ResolvedFault[]>();

    constructor(
        readonly site: SiteId,
        readonly spec: ChannelSpec,
        readonly seed: string,
        readonly epochMs: number,
        readonly source: string,
        readonly group: string,
        library: MediaLibrary,
        defaults: { window: number; endlistS: number; edges: string[] },
        readonly retentionMs: number,
    ) {
        this.renditions = library.group(source, group);
        this.durUs = this.renditions[0].segments.map(s => Math.max(1, Math.round(s.durationS * 1e6)));
        this.cumUs = [0];
        for (const d of this.durUs) this.cumUs.push(this.cumUs[this.cumUs.length - 1] + d);
        this.loopUs = this.cumUs[this.cumUs.length - 1];
        this.windowSize = spec.window ?? defaults.window;
        this.endlistMs = (spec.endlistS ?? defaults.endlistS) * 1000;
        const edgeSpecs: EdgeSpec[] = spec.edges ?? defaults.edges.map(id => ({ id }));
        this.edges = edgeSpecs.map((e, i) => ({
            id: e.id,
            lagMs: e.lagMs ?? (i === 0 ? 0 : intBetween(150, 900, seed, site, spec.id, e.id, "lag")),
            pdtSkewMs: e.pdtSkewMs ?? (i === 0 ? 0 : intBetween(-40, 40, seed, site, spec.id, e.id, "skew")),
            ...(e.firstSequence !== undefined ? { firstSequence: e.firstSequence } : {}),
        }));
    }

    get segmentCount(): number { return this.durUs.length; }
    get targetDurationS(): number { return Math.ceil(Math.max(...this.renditions.flatMap(r => r.segments.map(s => s.durationS)))); }

    edge(id: string): Edge | undefined {
        return this.edges.find(e => e.id === id);
    }

    // ---------- schedule ----------

    private sessionKey(index: number): string {
        let key = this.keyCache.get(index);
        if (!key) {
            key = hashHex(this.seed, this.site, this.spec.id, "session", index).slice(0, 16);
            this.keyCache.set(index, key);
        }
        return key;
    }

    /** Sessions overlapping [fromMs, toMs], with stream-end faults applied. */
    sessionsBetween(fromMs: number, toMs: number): Session[] {
        const s = this.spec.schedule;
        const raw: Array<{ index: number; startMs: number; endMs: number | null }> = [];
        if ("always" in s) {
            if (toMs >= this.epochMs) raw.push({ index: 0, startMs: this.epochMs, endMs: null });
        } else if ("sessions" in s) {
            s.sessions.forEach((x, index) => raw.push({
                index, startMs: this.epochMs + x.start * 1000, endMs: x.end === null ? null : this.epochMs + x.end * 1000,
            }));
        } else {
            const { periodS, onlineS, offsetS } = s.cycle;
            const base = this.epochMs + offsetS * 1000, period = periodS * 1000;
            const first = Math.max(0, Math.floor((fromMs - base - onlineS * 1000) / period));
            const last = Math.floor((toMs - base) / period);
            for (let index = first; index <= last; index++) {
                raw.push({ index, startMs: base + index * period, endMs: base + index * period + onlineS * 1000 });
            }
        }
        const cuts = this.spec.faults.filter(f => f.type === "streamEnd");
        const out: Session[] = [];
        for (const r of raw) {
            let end = r.endMs;
            for (const cut of cuts) {
                const at = cut.scope === "session" ? r.startMs + cut.at * 1000 : this.epochMs + cut.at * 1000;
                if (at > r.startMs && (end === null || at < end)) end = at;
            }
            if (r.startMs <= toMs && (end === null || end > fromMs)) {
                out.push({ index: r.index, startMs: r.startMs, endMs: end, key: this.sessionKey(r.index) });
            }
        }
        return out;
    }

    /** The session live at `t`, if any. */
    sessionAt(t: number): Session | null {
        return this.sessionsBetween(t, t).find(s => s.startMs <= t && (s.endMs === null || t < s.endMs)) ?? null;
    }

    /** The latest session that started at or before `t` (live or ended). */
    latestSession(t: number): Session | null {
        const all = this.sessionsBetween(t - LOOKBACK_MS, t).filter(s => s.startMs <= t);
        return all.length ? all[all.length - 1] : null;
    }

    sessionByKey(key: string, t: number): Session | null {
        return this.sessionsBetween(t - LOOKBACK_MS, t).find(s => s.key === key && s.startMs <= t) ?? null;
    }

    /** The channel's display name at `t` (renames apply from their time on). */
    nameAt(t: number): string {
        let name = this.spec.name;
        for (const r of this.spec.renames) if (this.epochMs + r.at * 1000 <= t) name = r.name;
        return name;
    }

    /** All names the channel has had by `t`, current first. */
    namesAt(t: number): string[] {
        const names = [this.spec.name, ...this.spec.renames.filter(r => this.epochMs + r.at * 1000 <= t).map(r => r.name)];
        return [...new Set(names.reverse())];
    }

    // ---------- timeline ----------

    startPosition(session: Session): number {
        return this.spec.startPosition !== undefined
            ? this.spec.startPosition % this.segmentCount
            : intBetween(0, this.segmentCount - 1, this.seed, this.site, this.spec.id, "start", session.index);
    }

    /** Offset of segment k's start from the session start, in microseconds. */
    private offUs(session: Session, k: number): number {
        const n = this.segmentCount, p = this.startPosition(session), a = p + k;
        return Math.floor(a / n) * this.loopUs + this.cumUs[a % n] - this.cumUs[p];
    }

    /** Number of segments whose start offset is at most `xUs`. */
    private countStartedBy(session: Session, xUs: number): number {
        // Instants arrive as float milliseconds; boundaries are whole microseconds.
        xUs = Math.round(xUs);
        if (xUs < 0) return 0;
        const n = this.segmentCount, p = this.startPosition(session);
        const total = this.cumUs[p] + xUs;
        const loops = Math.floor(total / this.loopUs);
        const rem = total - loops * this.loopUs;
        let lo = 0, hi = n; // first index i with cum[i] > rem
        while (lo < hi) { const mid = (lo + hi) >> 1; if (this.cumUs[mid] > rem) hi = mid; else lo = mid + 1; }
        return loops * n + lo - p;
    }

    /** First segment starting at or after `t`. */
    indexAtOrAfter(session: Session, t: number): number {
        const x = (t - session.startMs) * US;
        const started = this.countStartedBy(session, x - 1);
        return Math.max(0, started);
    }

    segmentStartMs(session: Session, k: number): number {
        return session.startMs + this.offUs(session, k) / US;
    }

    segmentEndMs(session: Session, k: number): number {
        return session.startMs + this.offUs(session, k + 1) / US;
    }

    /** Last segment complete by `t` (origin time), or -1. */
    lastCompleteBy(session: Session, t: number): number {
        const limit = session.endMs === null ? t : Math.min(t, session.endMs);
        return this.countStartedBy(session, (limit - session.startMs) * US) - 2;
    }

    finalIndex(session: Session): number | null {
        return session.endMs === null ? null : this.lastCompleteBy(session, session.endMs);
    }

    srcOf(session: Session, k: number): { srcIndex: number; loop: number; durationS: number } {
        const a = this.startPosition(session) + k, n = this.segmentCount;
        return { srcIndex: a % n, loop: Math.floor(a / n), durationS: this.durUs[a % n] / 1e6 };
    }

    // ---------- faults ----------

    faults(session: Session): ResolvedFault[] {
        let list = this.faultCache.get(session.index);
        if (!list) {
            list = this.spec.faults.map((fault, index) => {
                const origin = fault.scope === "session" ? session.startMs : this.epochMs;
                const fromMs = origin + fault.at * 1000;
                const untilMs = "until" in fault ? origin + fault.until * 1000 : Infinity;
                return { fault, index, fromMs, untilMs };
            });
            if (this.faultCache.size > 64) this.faultCache.clear();
            this.faultCache.set(session.index, list);
        }
        return list;
    }

    /** Faults of `type` active at `t` on `edge` (undefined edge = any). */
    active<T extends ChannelFault["type"]>(session: Session, type: T, t: number, edge?: string):
        Array<ResolvedFault & { fault: Extract<ChannelFault, { type: T }> }> {
        return this.faults(session).filter(f => f.fault.type === type && f.fromMs <= t && t < f.untilMs
            && (f.fault.edge === undefined || edge === undefined || f.fault.edge === edge)
            && (!("ratio" in f.fault) || f.fault.ratio === undefined
                || unit(this.seed, this.site, this.spec.id, "ratio", f.index, Math.floor(t / 1000)) < f.fault.ratio)) as any;
    }

    private boundaries(session: Session, edge: Edge) {
        const applies = (f: ResolvedFault) => f.fault.edge === undefined || f.fault.edge === edge.id;
        const skips = this.faults(session).filter(f => f.fault.type === "skip" && applies(f))
            .map(f => ({ at: this.indexAtOrAfter(session, f.fromMs), count: (f.fault as { count: number }).count }));
        const restarts = this.faults(session).filter(f => f.fault.type === "restart" && applies(f))
            .map(f => ({ at: this.indexAtOrAfter(session, f.fromMs), value: (f.fault as { value: number }).value }))
            .sort((a, b) => a.at - b.at);
        return { skips, restarts };
    }

    isSkipped(session: Session, edge: Edge, k: number): boolean {
        return this.boundaries(session, edge).skips.some(s => k >= s.at && k < s.at + s.count);
    }

    sequenceOf(session: Session, edge: Edge, k: number): number {
        const { restarts } = this.boundaries(session, edge);
        let seq = (edge.firstSequence ?? intBetween(0, 99999, this.seed, this.site, this.spec.id, edge.id, "seq", session.index)) + k;
        for (const r of restarts) if (k >= r.at) seq = r.value + (k - r.at);
        return seq;
    }

    /** Which rendition of the group serves `tier` for segment k, and any damage. */
    servedAs(session: Session, edge: Edge, k: number, tier: number): { rendition: number; damage: DamageKind | null } {
        const start = this.segmentStartMs(session, k);
        let rendition = tier, damage: DamageKind | null = null;
        for (const f of this.faults(session)) {
            if (f.fault.edge !== undefined && f.fault.edge !== edge.id) continue;
            if (start < f.fromMs || start >= f.untilMs) continue;
            if (f.fault.type === "codecChange") rendition = Math.min(tier + 1, this.renditions.length - 1);
            if (f.fault.type === "damage" && k % f.fault.every === 0) damage = f.fault.kind;
        }
        return { rendition, damage };
    }

    publishedAtMs(session: Session, edge: Edge, k: number): number {
        return this.segmentEndMs(session, k) + edge.lagMs;
    }

    // ---------- the live window ----------

    /** What `edge` lists for `session` at `t`, for rendition `tier`. */
    window(session: Session, edge: Edge, t: number, tier = 0): PlaylistWindow {
        const stale = this.active(session, "stalePlaylist", t, edge.id)[0];
        const staleAt = stale ? (stale.fault.staleByS !== undefined ? t - stale.fault.staleByS * 1000 : stale.fromMs) : null;
        const at = staleAt ?? t;
        const edgeTime = at - edge.lagMs;
        const { first, last } = this.windowAt(session, edge, at);
        const entries: WindowEntry[] = [];
        for (let k = first; k <= last; k++) {
            if (this.isSkipped(session, edge, k)) continue;
            const src = this.srcOf(session, k);
            const served = this.servedAs(session, edge, k, tier);
            entries.push({
                k, seq: this.sequenceOf(session, edge, k),
                pdtMs: this.segmentStartMs(session, k) + edge.pdtSkewMs,
                durationS: this.renditions[served.rendition].segments[src.srcIndex].durationS,
                rendition: served.rendition, srcIndex: src.srcIndex, loop: src.loop, damage: served.damage,
            });
        }
        const ended = session.endMs !== null && edgeTime >= session.endMs;
        const gone = session.endMs !== null && edgeTime >= session.endMs + this.endlistMs;
        return {
            session, edge, entries, ended, gone, staleAt,
            mediaSequence: entries.length ? entries[0].seq : this.sequenceOf(session, edge, Math.max(first, 0)),
        };
    }

    /** When segment k stops being listed on `edge` (ignoring stale caches). */
    listedUntilMs(session: Session, edge: Edge, k: number): number {
        const goneAt = session.endMs === null ? Infinity : session.endMs + this.endlistMs + edge.lagMs;
        for (let j = k + 1; j <= k + this.windowSize + 256; j++) {
            const t = this.publishedAtMs(session, edge, j);
            if (t >= goneAt) return goneAt;
            const w = this.windowAt(session, edge, t);
            if (w.first > k) return t;
        }
        return goneAt;
    }

    private windowAt(session: Session, edge: Edge, t: number): { first: number; last: number } {
        const edgeTime = t - edge.lagMs;
        const { skips, restarts } = this.boundaries(session, edge);
        let last = this.lastCompleteBy(session, edgeTime);
        let floor = 0;
        for (const s of skips) {
            if (last >= s.at && last < s.at + s.count) last = s.at - 1;
            else if (last >= s.at + s.count) floor = Math.max(floor, s.at + s.count);
        }
        for (const r of restarts) if (last >= r.at) floor = Math.max(floor, r.at);
        return { first: Math.max(floor, last - this.windowSize + 1, 0), last };
    }

    /**
     * Whether segment k can be fetched from `edge` at `t`: published, not
     * skipped, not past retention, not past the session's final segment.
     */
    segmentAvailability(session: Session, edge: Edge, k: number, t: number): "ok" | "not-yet" | "never" | "expired" {
        if (k < 0) return "never";
        const final = this.finalIndex(session);
        if (final !== null && k > final) return "never";
        if (this.isSkipped(session, edge, k)) return "never";
        const published = this.publishedAtMs(session, edge, k);
        if (t < published) return "not-yet";
        if (t >= published + this.retentionMs) return "expired";
        return "ok";
    }
}
