// The checker: compares a recording folder, as the capture client writes it,
// with the ground-truth log of what the site published.
//
// Folder format (the downloader's): segment files
// `<local number>_<recording identity>_<provider sequence>.ts` (fMP4
// fragments too), init files `init.mp4` / `init_<local>[_<n>].mp4`, and
// `playlist.m3u8` (EXTINF, DISCONTINUITY, MAP, ENDLIST; no date-times). A UTC
// recording identity is stored without colons or fraction
// (2026-06-01T12:00:00Z -> 2026-06-01T120000Z).
//
// Every file is matched to the session position k it holds: by provider
// sequence (numbering is per edge, so the edge follows from the sequence),
// then by SHA-256 against what the truth says was served. Positions between
// the first and last recorded one (or the whole session, or a time window)
// that the folder lacks are classified:
// - missed by the client: published on the edge the client was reading;
// - skipped by the site: never published on that edge (a provider skip),
//   with the edges that did carry it, if any.
// Files holding the same position twice are duplicates; files whose bytes
// differ from every served variant of their position are byte mismatches.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MediaLibrary } from "../media/library.js";
import type { DamageKind } from "../media/library.js";
import type { Availability, Interval, TruthIndex } from "../truth/query.js";

const SEGMENT_NAME = /^(\d+)_(.+)_(-?\d+)\.ts$/;
const INIT_NAME = /^init(?:_(\d+)(?:_(\d+))?)?\.mp4$/;
const UTC_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

/** The downloader's canonical form of a recording identity. */
export function normalizeRecordingId(id: string): string {
    const m = UTC_TIMESTAMP.exec(id);
    return m ? `${m[1]}T${m[2]}${m[3]}${m[4]}Z` : id;
}

export interface CheckOptions {
    site: string;
    channel: string;
    /** Recomputes hashes the log left out (catch-up publishing). */
    media?: MediaLibrary;
    /** What the client was expected to record (default: from its first to its last segment). */
    expect?: { mode: "recorded-span" } | { mode: "whole-session" } | { mode: "window"; from: number; to: number };
}

export interface FileVerdict {
    file: string;
    local: number;
    seq: number;
    bytes: number;
    sha256: string;
    k: number | null;
    edge: string | null;
    tier: string | null;
    status: "exact" | "mismatch" | "unverified" | "unknown";
    duplicate: boolean;
    damage: string | null;
}

export interface CheckReport {
    ok: boolean;
    verdict: string;
    site: string;
    channel: string;
    recording: {
        dir: string;
        recordingId: string | null;
        identities: string[];
        segmentFiles: number;
        initFiles: Array<{ file: string; sha256: string; known: boolean | null }>;
        playlist: { present: boolean; entries: number; ended: boolean; discontinuities: number; missingFiles: string[]; unreferencedFiles: string[] };
    };
    sessions: Array<{ session: string; recordingId: string; startMs: number; endMs: number | null }>;
    expected: { mode: string; fromK: number | null; toK: number | null; positions: number };
    counts: {
        files: number; exact: number; byteMismatches: number; unverified: number; unknownFiles: number; duplicates: number;
        recordedPositions: number; missedByClient: number; skippedBySite: number; damagedAsServed: number;
        outsideExpected: { before: number; after: number };
    };
    missedByClient: Array<{ k: number; pdt: string | null; edges: Array<{ edge: string; seq: number; listed: Interval }> }>;
    skippedBySite: Array<{ k: number; pdt: string | null; clientEdges: string[]; availableOn: Array<{ edge: string; seq: number }> }>;
    duplicates: Array<{ k: number; files: string[] }>;
    byteMismatches: Array<{ file: string; k: number; edge: string; seq: number; bytes: number; sha256: string; expected: Array<{ tier: string; sha256: string | null; bytes: number | null; damage: string | null }> }>;
    unknownFiles: Array<{ file: string; reason: string }>;
    files: FileVerdict[];
}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

interface Parsed { file: string; local: number; recordingId: string; seq: number }

function readFolder(dir: string): { segments: Parsed[]; inits: string[]; playlist: string | null; others: string[] } {
    if (!existsSync(dir)) throw new Error(`no recording folder at ${dir}`);
    const segments: Parsed[] = [];
    const inits: string[] = [];
    const others: string[] = [];
    for (const name of readdirSync(dir).sort()) {
        const m = SEGMENT_NAME.exec(name);
        if (m) {
            let id = m[2];
            try { if (id.includes("%")) id = decodeURIComponent(id); } catch { /* keep as is */ }
            segments.push({ file: name, local: Number(m[1]), recordingId: normalizeRecordingId(id), seq: Number(m[3]) });
        } else if (INIT_NAME.test(name)) inits.push(name);
        else if (name !== "playlist.m3u8") others.push(name);
    }
    segments.sort((a, b) => a.local - b.local);
    const playlistPath = join(dir, "playlist.m3u8");
    return { segments, inits, playlist: existsSync(playlistPath) ? readFileSync(playlistPath, "utf8") : null, others };
}

/** Picks the candidate that continues the recording: after the last position, on the same edge, earliest. */
function pick(cands: Availability[], prevK: number, prevEdge: string | null): Availability {
    return [...cands].sort((a, b) =>
        Number(a.k <= prevK) - Number(b.k <= prevK)
        || Number(a.edge !== prevEdge) - Number(b.edge !== prevEdge)
        || a.k - b.k || a.edge.localeCompare(b.edge) || a.tier.localeCompare(b.tier))[0];
}

export function checkRecording(truth: TruthIndex, dir: string, options: CheckOptions): CheckReport {
    const { site, channel } = options;
    const folder = readFolder(dir);
    const identities = [...new Set(folder.segments.map(s => s.recordingId))];
    const recordingId = identities.length === 1 ? identities[0] : null;
    const sessions = recordingId === null ? [] : truth.sessions({ site, channel }).filter(s => normalizeRecordingId(s.recordingId) === recordingId);
    const sessionKeys = new Set(sessions.map(s => s.session));
    const segs = truth.available({ site, channel }).filter(a => sessionKeys.has(a.session));
    const sourceOf = new Map(sessions.map(s => [s.session, s.source]));

    // Hashes the log left out, recomputed from the media when we have it.
    const expectedSha = (a: Availability): string | null => {
        if (a.sha256 !== null || !options.media) return a.sha256;
        const source = sourceOf.get(a.session);
        if (!source) return null;
        a.sha256 = sha256(options.media.segmentBytes({ source, rendition: a.rendition, index: a.srcIndex, loop: a.loop, damage: a.damage as DamageKind | null }));
        return a.sha256;
    };

    const bySeq = new Map<number, Availability[]>();
    for (const a of segs) {
        const list = bySeq.get(a.seq) ?? [];
        list.push(a);
        bySeq.set(a.seq, list);
    }

    // ---- files -> positions ----
    const verdicts: FileVerdict[] = [];
    const byteMismatches: CheckReport["byteMismatches"] = [];
    const unknownFiles: CheckReport["unknownFiles"] = [];
    if (identities.length > 1) unknownFiles.push({ file: "*", reason: `the folder mixes recording identities: ${identities.join(", ")}` });
    let prevK = -1;
    let prevEdge: string | null = null;
    for (const f of folder.segments) {
        const data = readFileSync(join(dir, f.file));
        const digest = sha256(data);
        const base: FileVerdict = { file: f.file, local: f.local, seq: f.seq, bytes: data.length, sha256: digest, k: null, edge: null, tier: null, status: "unknown", duplicate: false, damage: null };
        if (recordingId === null || sessions.length === 0) {
            unknownFiles.push({ file: f.file, reason: recordingId === null ? "mixed recording identities" : `no ${site} session of channel ${channel} has recording identity ${f.recordingId}` });
            verdicts.push(base);
            continue;
        }
        const cands = bySeq.get(f.seq) ?? [];
        if (cands.length === 0) {
            unknownFiles.push({ file: f.file, reason: `no segment with provider sequence ${f.seq} was published in the session` });
            verdicts.push(base);
            continue;
        }
        const exact = cands.filter(c => expectedSha(c) === digest);
        if (exact.length) {
            const a = pick(exact, prevK, prevEdge);
            verdicts.push({ ...base, k: a.k, edge: a.edge, tier: a.tier, status: "exact", damage: a.damage });
            prevK = a.k; prevEdge = a.edge;
            continue;
        }
        const a = pick(cands, prevK, prevEdge);
        const variants = cands.filter(c => c.k === a.k && c.edge === a.edge);
        // Without every served variant's hash (and no media to recompute it) a mismatch cannot be proven.
        const unverified = variants.some(c => expectedSha(c) === null);
        verdicts.push({ ...base, k: a.k, edge: a.edge, tier: unverified ? null : a.tier, status: unverified ? "unverified" : "mismatch", damage: a.damage });
        if (!unverified) {
            byteMismatches.push({
                file: f.file, k: a.k, edge: a.edge, seq: f.seq, bytes: data.length, sha256: digest,
                expected: variants.map(c => ({ tier: c.tier, sha256: c.sha256, bytes: c.bytes, damage: c.damage })),
            });
        }
        prevK = a.k; prevEdge = a.edge;
    }

    // ---- duplicates ----
    const filesAt = new Map<number, FileVerdict[]>();
    for (const v of verdicts) {
        if (v.k === null) continue;
        const list = filesAt.get(v.k) ?? [];
        list.push(v);
        filesAt.set(v.k, list);
    }
    const duplicates: CheckReport["duplicates"] = [];
    for (const [k, list] of [...filesAt].sort((a, b) => a[0] - b[0])) {
        if (list.length < 2) continue;
        duplicates.push({ k, files: list.map(v => v.file) });
        for (const v of list.slice(1)) v.duplicate = true;
    }

    // ---- coverage ----
    const published = new Map<number, Map<string, Availability>>();
    for (const a of segs) {
        const edges = published.get(a.k) ?? new Map<string, Availability>();
        if (!edges.has(a.edge)) edges.set(a.edge, a);
        published.set(a.k, edges);
    }
    const recordedK = [...filesAt.keys()].sort((a, b) => a - b);
    const allK = [...published.keys()].sort((a, b) => a - b);
    const expect = options.expect ?? { mode: "recorded-span" };
    let fromK: number | null = null, toK: number | null = null;
    if (expect.mode === "recorded-span" && recordedK.length) { fromK = recordedK[0]; toK = recordedK[recordedK.length - 1]; }
    if (expect.mode === "whole-session" && allK.length) {
        fromK = Math.min(allK[0], recordedK[0] ?? Infinity);
        toK = Math.max(allK[allK.length - 1], recordedK[recordedK.length - 1] ?? -Infinity);
    }
    if (expect.mode === "window") {
        const inWindow = segs.filter(a => a.listed.from < expect.to && a.listed.until > expect.from).map(a => a.k);
        if (inWindow.length) { fromK = Math.min(...inWindow); toK = Math.max(...inWindow); }
    }
    const missedByClient: CheckReport["missedByClient"] = [];
    const skippedBySite: CheckReport["skippedBySite"] = [];
    const edgeAt = (k: number) => filesAt.get(k)?.find(v => v.edge !== null)?.edge ?? null;
    if (fromK !== null && toK !== null) {
        let before: string | null = null;
        for (let k = fromK; k <= toK; k++) {
            if (filesAt.has(k)) { before = edgeAt(k) ?? before; continue; }
            const afterK = recordedK.find(x => x > k);
            const after = afterK === undefined ? null : edgeAt(afterK);
            const clientEdges = [...new Set([before, after].filter((e): e is string => e !== null))];
            const edges = published.get(k);
            // Without any recorded neighbour (an expectation wider than the recording), any edge counts.
            const reading = clientEdges.length ? clientEdges : [...(edges?.keys() ?? [])];
            const onReading = reading.filter(e => edges?.has(e));
            const pdt = edges ? [...edges.values()][0].pdt : null;
            if (onReading.length) {
                missedByClient.push({ k, pdt, edges: onReading.map(e => ({ edge: e, seq: edges!.get(e)!.seq, listed: edges!.get(e)!.listed })) });
            } else {
                skippedBySite.push({ k, pdt, clientEdges: reading, availableOn: [...(edges?.entries() ?? [])].map(([edge, a]) => ({ edge, seq: a.seq })) });
            }
        }
    }

    // ---- folder bookkeeping ----
    const lines = (folder.playlist ?? "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const entries = lines.filter(l => !l.startsWith("#"));
    const onDisk = new Set([...folder.segments.map(s => s.file), ...folder.inits]);
    const maps = lines.filter(l => l.startsWith("#EXT-X-MAP:")).map(l => /URI="([^"]+)"/.exec(l)?.[1]).filter((u): u is string => !!u);
    const referenced = new Set([...entries, ...maps]);
    const knownInits = new Set<string>();
    for (const r of truth.responses({ site, channel, kind: "init" })) if (r.sha256) knownInits.add(r.sha256);
    if (options.media) {
        for (const s of sessions) {
            const m = options.media.sources.get(s.source);
            for (const r of Object.values(m?.renditions ?? {})) if (r.init) knownInits.add(r.init.sha256);
        }
    }
    const initFiles = folder.inits.map(file => {
        const digest = sha256(readFileSync(join(dir, file)));
        return { file, sha256: digest, known: knownInits.size ? knownInits.has(digest) : null };
    });
    const playlist = {
        present: folder.playlist !== null, entries: entries.length, ended: lines.includes("#EXT-X-ENDLIST"),
        discontinuities: lines.filter(l => l === "#EXT-X-DISCONTINUITY").length,
        missingFiles: [...referenced].filter(f => !onDisk.has(f)),
        unreferencedFiles: folder.playlist === null ? [] : folder.segments.map(s => s.file).filter(f => !referenced.has(f)),
    };

    const exact = verdicts.filter(v => v.status === "exact").length;
    const counts: CheckReport["counts"] = {
        files: verdicts.length, exact, byteMismatches: byteMismatches.length,
        unverified: verdicts.filter(v => v.status === "unverified").length,
        unknownFiles: unknownFiles.length, duplicates: duplicates.reduce((n, d) => n + d.files.length - 1, 0),
        recordedPositions: recordedK.length, missedByClient: missedByClient.length, skippedBySite: skippedBySite.length,
        damagedAsServed: verdicts.filter(v => v.status === "exact" && v.damage !== null).length,
        outsideExpected: {
            before: fromK === null ? 0 : allK.filter(k => k < fromK!).length,
            after: toK === null ? 0 : allK.filter(k => k > toK!).length,
        },
    };
    const problems: string[] = [];
    if (counts.missedByClient) problems.push(`the client missed ${counts.missedByClient} segment(s)`);
    if (counts.byteMismatches) problems.push(`${counts.byteMismatches} byte mismatch(es)`);
    if (counts.duplicates) problems.push(`${counts.duplicates} duplicate(s)`);
    if (counts.unknownFiles) problems.push(`${counts.unknownFiles} file(s) the site never published`);
    if (playlist.missingFiles.length) problems.push(`the playlist names ${playlist.missingFiles.length} missing file(s)`);
    if (folder.segments.length === 0) problems.push("no segments in the folder");
    const ok = problems.length === 0;
    return {
        ok, verdict: ok ? "OK" : `FAIL: ${problems.join(", ")}`,
        site, channel,
        recording: { dir, recordingId, identities, segmentFiles: folder.segments.length, initFiles, playlist },
        sessions: sessions.map(s => ({ session: s.session, recordingId: s.recordingId, startMs: s.startMs, endMs: s.endMs })),
        expected: { mode: expect.mode, fromK, toK, positions: fromK === null || toK === null ? 0 : toK - fromK + 1 },
        counts, missedByClient, skippedBySite, duplicates, byteMismatches, unknownFiles, files: verdicts,
    };
}

const ranges = (ks: number[]) => {
    const out: string[] = [];
    for (let i = 0; i < ks.length; i++) {
        let j = i;
        while (j + 1 < ks.length && ks[j + 1] === ks[j] + 1) j++;
        out.push(i === j ? `${ks[i]}` : `${ks[i]}-${ks[j]}`);
        i = j;
    }
    return out.join(", ");
};

/** A few lines for a person: what was expected, what is there, what is wrong and whose fault. */
export function formatReport(r: CheckReport): string {
    const c = r.counts;
    const lines = [
        `${r.site}/${r.channel} recording ${r.recording.recordingId ?? "(unknown identity)"} in ${r.recording.dir}`,
        `  session${r.sessions.length === 1 ? "" : "s"}: ${r.sessions.map(s => s.session).join(", ") || "none found"}`,
        `  expected: positions ${r.expected.fromK ?? "-"}..${r.expected.toK ?? "-"} (${r.expected.positions}, ${r.expected.mode})`
            + (c.outsideExpected.before || c.outsideExpected.after ? `; ${c.outsideExpected.before} published before, ${c.outsideExpected.after} after` : ""),
        `  files: ${c.files} (${c.exact} exact, ${c.byteMismatches} byte mismatches, ${c.unverified} unverified, ${c.duplicates} duplicates, ${c.unknownFiles} unknown)`,
        `  missed by the client: ${c.missedByClient}${c.missedByClient ? ` (k ${ranges(r.missedByClient.map(m => m.k))})` : ""}`,
        `  skipped by the site: ${c.skippedBySite}${c.skippedBySite ? ` (k ${ranges(r.skippedBySite.map(m => m.k))}`
            + `${r.skippedBySite.some(s => s.availableOn.length) ? `; ${r.skippedBySite.filter(s => s.availableOn.length).length} were on another edge` : ""})` : ""}`,
    ];
    if (c.damagedAsServed) lines.push(`  damaged as served (kept as received): ${c.damagedAsServed}`);
    for (const d of r.duplicates.slice(0, 5)) lines.push(`  duplicate k ${d.k}: ${d.files.join(", ")}`);
    for (const m of r.byteMismatches.slice(0, 5)) lines.push(`  mismatch ${m.file}: k ${m.k} on edge ${m.edge}, ${m.bytes} bytes, sha256 ${m.sha256.slice(0, 12)}`);
    for (const u of r.unknownFiles.slice(0, 5)) lines.push(`  unknown ${u.file}: ${u.reason}`);
    const p = r.recording.playlist;
    lines.push(`  playlist: ${p.present ? `${p.entries} entries, ${p.discontinuities} discontinuities${p.ended ? ", ENDLIST" : ", open"}` : "missing"}`
        + (p.missingFiles.length ? `, ${p.missingFiles.length} missing files` : "") + (p.unreferencedFiles.length ? `, ${p.unreferencedFiles.length} unreferenced files` : ""));
    if (r.recording.initFiles.length) lines.push(`  init files: ${r.recording.initFiles.map(i => `${i.file}${i.known === false ? " (unknown bytes)" : ""}`).join(", ")}`);
    lines.push(`verdict: ${r.verdict}`);
    return lines.join("\n");
}
