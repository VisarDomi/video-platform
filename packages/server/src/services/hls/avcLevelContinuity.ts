import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseNativeMediaPlaylist } from "shared";

interface Box { start: number; size: number; header: number; type: string }
interface Initialization {
    bytes: Buffer; track: number; entry: Box; levelAt: number; spsAt: number;
    sps: Buffer; pps: Buffer; lengthBytes: number; timescales: ReadonlyMap<number, number>;
}
export interface HlsPlaybackPresentation {
    playlist: string;
    initializations: ReadonlyMap<string, Buffer>;
    boundaries: readonly { index: number; mode: "in-band" | "stable"; levels: readonly number[] }[];
    durationCorrections: number;
    skippedReason?: string;
}
const cache = new Map<string, { signature: string; result: Promise<HlsPlaybackPresentation> }>();
const ORIGINAL = (playlist: string): HlsPlaybackPresentation => ({ playlist, initializations: new Map(), boundaries: [], durationCorrections: 0 });

function boxes(data: Buffer, start = 0, end = data.length): Box[] {
    const result: Box[] = [];
    while (start < end) {
        if (start + 8 > end) throw new Error("Truncated MP4 box");
        let size = data.readUInt32BE(start), header = 8;
        if (size === 1) {
            if (start + 16 > end) throw new Error("Truncated extended MP4 box");
            size = Number(data.readBigUInt64BE(start + 8)); header = 16;
        } else if (size === 0) size = end - start;
        if (!Number.isSafeInteger(size) || size < header || start + size > end) throw new Error("Invalid MP4 box size");
        result.push({ start, size, header, type: data.toString("ascii", start + 4, start + 8) });
        start += size;
    }
    return result;
}
function child(data: Buffer, parent: Box, type: string, extra = 0): Box | undefined {
    return boxes(data, parent.start + parent.header + extra, parent.start + parent.size).find(box => box.type === type);
}
function initialization(bytes: Buffer): Initialization | null {
    const moov = boxes(bytes).find(box => box.type === "moov");
    if (!moov) return null;
    let found: Initialization | null = null;
    const timescales = new Map<number, number>();
    for (const trak of boxes(bytes, moov.start + moov.header, moov.start + moov.size).filter(box => box.type === "trak")) {
        const tkhd = child(bytes, trak, "tkhd"), mdia = child(bytes, trak, "mdia");
        if (!tkhd || !mdia) continue;
        const trackAt = tkhd.start + tkhd.header + (bytes[tkhd.start + tkhd.header] === 1 ? 20 : 12);
        const track = bytes.readUInt32BE(trackAt), mdhd = child(bytes, mdia, "mdhd");
        const hdlr = child(bytes, mdia, "hdlr");
        const handler = hdlr ? bytes.toString("ascii", hdlr.start + hdlr.header + 8, hdlr.start + hdlr.header + 12) : "";
        if (handler === "vide" || handler === "soun") {
            timescales.set(track, mdhd ? bytes.readUInt32BE(mdhd.start + mdhd.header + (bytes[mdhd.start + mdhd.header] === 1 ? 20 : 12)) : 0);
        }
        const minf = mdia && child(bytes, mdia, "minf"), stbl = minf && child(bytes, minf, "stbl");
        const stsd = stbl && child(bytes, stbl, "stsd");
        if (!tkhd || !stsd) continue;
        const entries = boxes(bytes, stsd.start + stsd.header + 8, stsd.start + stsd.size);
        const entry = entries.find(box => box.type === "avc1");
        if (!entry) continue;
        if (found || entries.length !== 1 || bytes.readUInt32BE(stsd.start + stsd.header + 4) !== 1) {
            throw new Error("Multiple AVC sample descriptions are not normalized");
        }
        const avcc = child(bytes, entry, "avcC", 78);
        if (!avcc) continue;
        const at = avcc.start + avcc.header;
        if (at + 8 > avcc.start + avcc.size || bytes[at] !== 1 || (bytes[at + 5] & 31) !== 1) {
            throw new Error("Unsupported AVC configuration");
        }
        const spsSize = bytes.readUInt16BE(at + 6), spsAt = at + 8;
        const countAt = spsAt + spsSize;
        if (spsSize < 4 || countAt + 3 > avcc.start + avcc.size || bytes[countAt] !== 1) throw new Error("Unsupported AVC parameter sets");
        const ppsSize = bytes.readUInt16BE(countAt + 1), ppsAt = countAt + 3;
        if (ppsSize === 0 || ppsAt + ppsSize > avcc.start + avcc.size) throw new Error("Truncated AVC parameter sets");
        const sps = bytes.subarray(spsAt, spsAt + spsSize), pps = bytes.subarray(ppsAt, ppsAt + ppsSize);
        if ((sps[0] & 31) !== 7 || (pps[0] & 31) !== 8 || bytes[at + 1] !== sps[1] || bytes[at + 2] !== sps[2]) {
            throw new Error("Inconsistent AVC configuration");
        }
        found = { bytes, entry, track, levelAt: at + 3, spsAt, sps, pps, timescales,
            lengthBytes: (bytes[at + 4] & 3) + 1 };
    }
    return found;
}

// Read sample locations from the indexes, not by searching compressed payloads.
// No sample, index or media byte is rewritten by this playback compatibility path.
function fragmentSamples(data: Buffer, init: Initialization): { video: Buffer[]; start: number | null; end: number | null } {
    const result: Buffer[] = [];
    let first = Infinity, last = -Infinity, timingKnown = true;
    const top = boxes(data);
    for (const [index, moof] of top.entries()) {
        if (moof.type !== "moof") continue;
        const mdat = top[index + 1];
        if (mdat?.type !== "mdat") throw new Error("Missing fragment media payload");
        let previousEnd = moof.start;
        for (const traf of boxes(data, moof.start + moof.header, moof.start + moof.size).filter(box => box.type === "traf")) {
            const entries = boxes(data, traf.start + traf.header, traf.start + traf.size);
            const tfhd = entries.find(box => box.type === "tfhd");
            if (!tfhd) throw new Error("Missing track header");
            const flags = data.readUIntBE(tfhd.start + tfhd.header + 1, 3);
            const id = data.readUInt32BE(tfhd.start + tfhd.header + 4);
            let at = tfhd.start + tfhd.header + 8;
            let base = flags & 0x20000 ? moof.start : previousEnd;
            if (flags & 1) { base = Number(data.readBigUInt64BE(at)); at += 8; }
            if (flags & 2) {
                if (id === init.track && data.readUInt32BE(at) !== 1) throw new Error("Unsupported sample description index");
                at += 4;
            }
            const defaultDuration = flags & 8 ? data.readUInt32BE(at) : 0;
            if (flags & 8) at += 4;
            const defaultSize = flags & 16 ? data.readUInt32BE(at) : null;
            const tfdt = entries.find(box => box.type === "tfdt"), scale = init.timescales.get(id);
            let dts = tfdt ? data[tfdt.start + tfdt.header] === 1
                ? Number(data.readBigUInt64BE(tfdt.start + tfdt.header + 4)) : data.readUInt32BE(tfdt.start + tfdt.header + 4) : NaN;
            let end = base;
            for (const run of entries.filter(box => box.type === "trun")) {
                const f = data.readUIntBE(run.start + run.header + 1, 3);
                const count = data.readUInt32BE(run.start + run.header + 4);
                at = run.start + run.header + 8;
                let offset = end;
                if (f & 1) { offset = base + data.readInt32BE(at); at += 4; }
                if (f & 4) at += 4;
                const stride = 4 * [0x100, 0x200, 0x400, 0x800].filter(flag => f & flag).length;
                if (at + stride * count > run.start + run.size) throw new Error("Truncated sample index");
                for (let i = 0; i < count; i++) {
                    const entryAt = at + i * stride;
                    const duration = f & 0x100 ? data.readUInt32BE(entryAt) : defaultDuration;
                    const size = f & 0x200 ? data.readUInt32BE(entryAt + (f & 0x100 ? 4 : 0)) : defaultSize;
                    if (size === null || offset < mdat.start + mdat.header || offset + size > mdat.start + mdat.size) {
                        throw new Error("Unsupported sample layout");
                    }
                    if (id === init.track && size > 0) result.push(data.subarray(offset, offset + size));
                    let composition = 0;
                    if (f & 0x800) {
                        const compositionAt = entryAt + 4 * [0x100, 0x200, 0x400].filter(flag => f & flag).length;
                        composition = data[run.start + run.header] === 1 ? data.readInt32BE(compositionAt) : data.readUInt32BE(compositionAt);
                    }
                    if (scale && Number.isSafeInteger(dts) && duration > 0) {
                        first = Math.min(first, (dts + composition) / scale);
                        last = Math.max(last, (dts + composition + duration) / scale);
                    } else if (init.timescales.has(id)) timingKnown = false;
                    dts += duration;
                    offset += size;
                }
                end = offset;
            }
            previousEnd = end;
        }
    }
    return { video: result, start: timingKnown && Number.isFinite(first) ? first : null,
        end: timingKnown && Number.isFinite(last) ? last : null };
}

function levelsInFragment(samples: readonly Buffer[], init: Initialization, current: { level: number }): number[] {
    const levels = new Set<number>();
    for (const sample of samples) {
        for (let at = 0; at < sample.length;) {
            if (at + init.lengthBytes > sample.length) throw new Error("Truncated AVC NAL length");
            const size = sample.readUIntBE(at, init.lengthBytes); at += init.lengthBytes;
            if (size === 0 || at + size > sample.length) throw new Error("Invalid AVC NAL length");
            const nal = sample.subarray(at, at + size), type = nal[0] & 31;
            if (type === 7) {
                // A level-only update leaves geometry, reference structure, VUI
                // and every other decoder parameter unchanged. Broader changes
                // need their own repair, rather than guessed initialization.
                if (nal.length !== init.sps.length || nal.some((byte, i) => i !== 3 && byte !== init.sps[i])) {
                    throw new Error("AVC update changes more than its declared level");
                }
                current.level = nal[3];
            } else if (type === 8 && !nal.equals(init.pps)) throw new Error("AVC picture parameter set changed");
            else if (type === 1 || type === 5) levels.add(current.level);
            at += size;
        }
    }
    return [...levels];
}

async function build(directory: string, content: string, parsed: ReturnType<typeof parseNativeMediaPlaylist>, inits: Map<string, Initialization | null>): Promise<HlsPlaybackPresentation> {
    const generated = new Map<string, Buffer>();
    const plans = new Map<number, string>();
    const durations = new Map<number, number>();
    const boundaries: { index: number; mode: "in-band" | "stable"; levels: number[] }[] = [];
    let originalMap: string | null = null, renderedMap: string | null = null;
    let current = { level: 0 };
    let previousEnd: number | null = null, timingValid = true;
    let runIndexes: number[] = [];
    for (const segment of parsed.segments) {
        if (segment.mapUri !== originalMap) {
            originalMap = renderedMap = segment.mapUri;
            current = { level: originalMap ? inits.get(originalMap)?.sps[3] ?? 0 : 0 };
            previousEnd = null; timingValid = true; runIndexes = [];
        } else if (segment.metadata.includes("#EXT-X-DISCONTINUITY")) {
            current = { level: originalMap ? inits.get(originalMap)?.sps[3] ?? 0 : 0 };
            previousEnd = null; timingValid = true; runIndexes = [];
        }
        const init = originalMap ? inits.get(originalMap) : null;
        if (!init) continue;
        const analysis = fragmentSamples(await fs.readFile(path.join(directory, segment.name)), init);
        runIndexes.push(segment.index);
        // Individual AAC/video spans can overlap neighbouring fragments. Using
        // the longest span for every EXTINF accumulates drift. Endpoint deltas
        // preserve the complete A/V timeline and its real held-video intervals.
        if (analysis.start !== null && analysis.end !== null && timingValid) {
            const duration = analysis.end - (previousEnd ?? analysis.start);
            if (duration > 0 && duration < 3600) {
                if (Math.abs(duration - segment.durationSeconds) > 0.000001) durations.set(segment.index, duration);
                previousEnd = analysis.end;
            } else timingValid = false;
        } else timingValid = false;
        if (!timingValid) for (const index of runIndexes) durations.delete(index);
        const levels = levelsInFragment(analysis.video, init, current);
        if (!levels.length) continue;
        const mixed = levels.length > 1;
        let desired = originalMap!;
        if (mixed || levels[0] !== init.sps[3]) {
            const bytes = Buffer.from(init.bytes);
            bytes[init.levelAt] = Math.max(...levels);
            bytes[init.spsAt + 3] = mixed ? Math.max(...levels) : levels[0];
            if (mixed) bytes.write("avc3", init.entry.start + 4, 4, "ascii");
            const name = `_playback-init-${createHash("sha256").update(bytes).digest("hex")}.mp4`;
            generated.set(name, bytes); desired = name;
        }
        if (desired !== renderedMap) {
            plans.set(segment.index, desired); renderedMap = desired;
            boundaries.push({ index: segment.index, mode: mixed ? "in-band" : "stable", levels });
        }
    }
    if (!plans.size && !durations.size) return ORIGINAL(content);
    let index = 0;
    const lines: string[] = [];
    const targetDuration = Math.max(1, Math.ceil(parsed.segments.reduce((max, segment) =>
        Math.max(max, durations.get(segment.index) ?? segment.durationSeconds), 0) - 0.000001));
    for (const line of content.split(/\r?\n/)) {
        if (line.startsWith("#EXT-X-TARGETDURATION:") && Number(line.split(":")[1]) < targetDuration) {
            lines.push(`#EXT-X-TARGETDURATION:${targetDuration}`); continue;
        }
        if (line.trim().startsWith("#EXTINF:")) {
            const desired = plans.get(index), duration = durations.get(index), segment = parsed.segments[index++];
            if (desired) {
                if (!segment.metadata.includes("#EXT-X-DISCONTINUITY")) lines.push("#EXT-X-DISCONTINUITY");
                lines.push(`#EXT-X-MAP:URI="${desired}"`);
            }
            if (duration !== undefined) { lines.push(line.replace(/(#EXTINF:)[^,]+/,`$1${duration.toFixed(9)}`)); continue; }
        }
        lines.push(line);
    }
    return { playlist: lines.join("\n"), initializations: generated, boundaries, durationCorrections: durations.size };
}

// Completed originals stay immutable. The served manifest/initializations are
// derived deterministically; cache loss or a reboot simply rebuilds this view.
export async function hlsPlaybackPresentation(directory: string, content: string): Promise<HlsPlaybackPresentation> {
    if (!content.includes("#EXT-X-ENDLIST") || !content.includes("#EXT-X-MAP:")) return ORIGINAL(content);
    let parsed: ReturnType<typeof parseNativeMediaPlaylist>;
    try { parsed = parseNativeMediaPlaylist(content); } catch { return ORIGINAL(content); }
    const maps = [...new Set(parsed.segments.map(segment => segment.mapUri).filter((name): name is string => Boolean(name)))];
    const inits = new Map<string, Initialization | null>();
    for (const name of maps) {
        const bytes = await fs.readFile(path.join(directory, name));
        try { inits.set(name, initialization(bytes)); } catch { return ORIGINAL(content); }
    }
    if (![...inits.values()].some(Boolean)) return ORIGINAL(content);
    const fingerprint = createHash("sha256").update(content);
    const names = [...new Set([...maps, ...parsed.segments.map(segment => segment.name)])];
    for (const name of names) {
        const stat = await fs.stat(path.join(directory, name));
        fingerprint.update(`\0${name}\0${stat.size}\0${stat.mtimeMs}`);
    }
    const signature = fingerprint.digest("hex");
    const previous = cache.get(directory);
    if (previous?.signature === signature) return previous.result;
    const result = build(directory, content, parsed, inits).catch(error => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code && !code.startsWith("ERR_")) { cache.delete(directory); throw error; }
        return { ...ORIGINAL(content), skippedReason: error instanceof Error ? error.message : String(error) };
    });
    cache.delete(directory); cache.set(directory, { signature, result });
    while (cache.size > 16) cache.delete(cache.keys().next().value!);
    return result;
}

export const isPlaybackInitialization = (name: string): boolean => /^_playback-init-[a-f0-9]{64}\.mp4$/.test(name);
