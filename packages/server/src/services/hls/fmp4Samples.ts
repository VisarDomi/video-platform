// Strict capture-index reader and sample-copy writer. No decoding or encoding.
export interface Mp4Box { at: number; size: number; header: number; type: string }
export function mp4Boxes(data: Buffer, begin = 0, end = data.length): Mp4Box[] {
    const result: Mp4Box[] = [];
    for (let at = begin; at < end;) {
        if (at + 8 > end) throw new Error("Truncated MP4 box");
        let size = data.readUInt32BE(at), header = 8;
        if (size === 1) { size = Number(data.readBigUInt64BE(at + 8)); header = 16; }
        if (size === 0) size = end - at;
        if (!Number.isSafeInteger(size) || size < header || at + size > end) throw new Error("Invalid MP4 box size");
        result.push({ at, size, header, type: data.toString("ascii", at + 4, at + 8) }); at += size;
    }
    return result;
}
const children = (b: Buffer, p: Mp4Box, skip = 0) => mp4Boxes(b, p.at + p.header + skip, p.at + p.size);
const child = (b: Buffer, p: Mp4Box, type: string, skip = 0) => children(b, p, skip).find(x => x.type === type);
export interface CaptureTrack { id: number; kind: string; scale: number; duration: number; size: number; flags: number }
export interface AvcInitialization {
    bytes: Buffer; tracks: Map<number, CaptureTrack>; audioDescriptions: Map<number, Buffer>; video: number; sps: Buffer; pps: Buffer;
    lengthBytes: number; levelAt: number; spsAt: number;
}
export function readAvcInitialization(bytes: Buffer): AvcInitialization | null {
    const moov = mp4Boxes(bytes).find(x => x.type === "moov");
    if (!moov) return null;
    const defaults = new Map<number, number[]>(), mvex = child(bytes, moov, "mvex");
    if (mvex) for (const t of children(bytes, mvex).filter(x => x.type === "trex")) {
        const at = t.at + t.header + 4;
        if (bytes.readUInt32BE(at + 4) !== 1) throw new Error("Multiple sample descriptions");
        defaults.set(bytes.readUInt32BE(at), [bytes.readUInt32BE(at + 8), bytes.readUInt32BE(at + 12), bytes.readUInt32BE(at + 16)]);
    }
    const tracks = new Map<number, CaptureTrack>(), audioDescriptions = new Map<number, Buffer>();
    let found: Omit<AvcInitialization, "tracks" | "audioDescriptions"> | null = null;
    for (const trak of children(bytes, moov).filter(x => x.type === "trak")) {
        const tkhd = child(bytes, trak, "tkhd"), mdia = child(bytes, trak, "mdia"); if (!tkhd || !mdia) continue;
        const mdhd = child(bytes, mdia, "mdhd"), hdlr = child(bytes, mdia, "hdlr"); if (!mdhd || !hdlr) continue;
        const id = bytes.readUInt32BE(tkhd.at + tkhd.header + (bytes[tkhd.at + tkhd.header] === 1 ? 20 : 12));
        const scale = bytes.readUInt32BE(mdhd.at + mdhd.header + (bytes[mdhd.at + mdhd.header] === 1 ? 20 : 12));
        const kind = bytes.toString("ascii", hdlr.at + hdlr.header + 8, hdlr.at + hdlr.header + 12), def = defaults.get(id) ?? [0, 0, 0];
        if (!scale || !["vide", "soun"].includes(kind)) throw new Error("Unsupported capture track");
        tracks.set(id, { id, kind, scale, duration: def[0], size: def[1], flags: def[2] });
        const minf = child(bytes, mdia, "minf"), stbl = minf && child(bytes, minf, "stbl"), stsd = stbl && child(bytes, stbl, "stsd");
        if (!stsd) throw new Error("Missing sample description");
        if (kind === "soun") {
            audioDescriptions.set(id, bytes.subarray(stsd.at + stsd.header + 8, stsd.at + stsd.size));
            continue;
        }
        const entries = children(bytes, stsd, 8); if (entries.length !== 1 || entries[0].type !== "avc1" || found) throw new Error("Unsupported AVC descriptions");
        const avcc = child(bytes, entries[0], "avcC", 78); if (!avcc) throw new Error("Missing AVC configuration");
        const at = avcc.at + avcc.header;
        if (bytes[at] !== 1 || (bytes[at + 5] & 31) !== 1) throw new Error("Unsupported AVC parameter sets");
        const size = bytes.readUInt16BE(at + 6), spsAt = at + 8, countAt = spsAt + size;
        if (size < 4 || bytes[countAt] !== 1) throw new Error("Unsupported AVC parameter sets");
        const ppsAt = countAt + 3, ppsSize = bytes.readUInt16BE(countAt + 1);
        const end = avcc.at + avcc.size;
        let extra = ppsAt + ppsSize;
        if (!ppsSize || extra > end) throw new Error("Invalid AVC parameter sets");
        // High profiles carry chroma/bit-depth fields and optional SPS_EXT NALs
        // after PPS. These are configuration bytes, not trailing media. Validate
        // their index and preserve them verbatim in any copied initialization.
        if (extra < end) {
            if ([66, 77, 88].includes(bytes[at + 1]) || extra + 4 > end
                || (bytes[extra] & 0xfc) !== 0xfc || (bytes[extra + 1] & 0xf8) !== 0xf8
                || (bytes[extra + 2] & 0xf8) !== 0xf8) throw new Error("Invalid AVC extension header");
            const count = bytes[extra + 3]; extra += 4;
            for (let i = 0; i < count; i++) {
                if (extra + 2 > end) throw new Error("Truncated AVC extension index");
                const length = bytes.readUInt16BE(extra); extra += 2;
                if (!length || extra + length > end || (bytes[extra] & 31) !== 13) throw new Error("Invalid AVC extension payload");
                extra += length;
            }
            if (extra !== end) throw new Error("Unindexed AVC extension bytes");
        }
        const sps = bytes.subarray(spsAt, spsAt + size), pps = bytes.subarray(ppsAt, ppsAt + ppsSize);
        if ((sps[0] & 31) !== 7 || (pps[0] & 31) !== 8) throw new Error("Invalid AVC parameter sets");
        found = { bytes, video: id, sps, pps, spsAt, levelAt: at + 3, lengthBytes: (bytes[at + 4] & 3) + 1 };
    }
    return found ? { ...found, tracks, audioDescriptions } : null;
}
export function compatibleCaptureInitializations(left: AvcInitialization, right: AvcInitialization): boolean {
    return left.video === right.video && left.lengthBytes === right.lengthBytes && left.tracks.size === right.tracks.size
        && [...left.tracks].every(([id, track]) => {
            const other = right.tracks.get(id);
            return other && track.kind === other.kind && track.scale === other.scale && track.duration === other.duration
                && track.size === other.size && track.flags === other.flags
                && (track.kind !== "soun" || left.audioDescriptions.get(id)!.equals(right.audioDescriptions.get(id)!));
        });
}
export interface CaptureSample { bytes: Buffer; dts: number; duration: number; cto: number; flags: number }
export interface CaptureRun { track: CaptureTrack; samples: CaptureSample[] }
export interface CaptureChunk { sequence: number; runs: CaptureRun[]; bytes: Buffer }
function validateSeekTrailer(data: Buffer, trailer: Mp4Box, init: AvcInitialization): void {
    const fields = children(data, trailer), footer = fields.at(-1);
    if (!footer || footer.type !== "mfro" || footer.size !== footer.header + 8
        || data.readUInt32BE(footer.at + footer.header) !== 0
        || data.readUInt32BE(footer.at + footer.header + 4) !== trailer.size) throw new Error("Invalid mfra seek-index footer");
    for (const index of fields.slice(0, -1)) {
        const at = index.at + index.header;
        if (index.type !== "tfra" || index.size < index.header + 16 || data[at] > 1
            || data.readUIntBE(at + 1, 3) !== 0 || !init.tracks.has(data.readUInt32BE(at + 4))) throw new Error("Unsupported mfra seek index");
        const lengths = data.readUInt32BE(at + 8), count = data.readUInt32BE(at + 12);
        if (lengths & ~0x3f) throw new Error("Invalid seek-index reserved bits");
        const entrySize = (data[at] === 1 ? 16 : 8)
            + ((lengths >> 4 & 3) + 1) + ((lengths >> 2 & 3) + 1) + ((lengths & 3) + 1);
        if (index.size !== index.header + 16 + count * entrySize) throw new Error("Truncated or unindexed seek-index entries");
    }
}
export function readCaptureChunks(data: Buffer, init: AvcInitialization): CaptureChunk[] {
    const top = mp4Boxes(data), chunks: CaptureChunk[] = [];
    if (top.some(b => !["sidx", "styp", "moof", "mdat", "mfra"].includes(b.type))) throw new Error("Unsupported fragment boxes");
    for (const [i, box] of top.entries()) if (box.type === "mfra") {
        if (i !== top.length - 1 || top[i - 1]?.type !== "mdat") throw new Error("Misplaced mfra seek-index trailer");
        validateSeekTrailer(data, box, init);
    }
    if (top.some((b, i) => b.type === "mdat" && top[i - 1]?.type !== "moof")) throw new Error("Unindexed media box");
    for (const [index, moof] of top.entries()) {
        if (moof.type !== "moof") continue;
        const mdat = top[index + 1]; if (mdat?.type !== "mdat") throw new Error("Missing mdat");
        const boxes = children(data, moof), mfhd = boxes.find(x => x.type === "mfhd"); if (!mfhd) throw new Error("Missing mfhd");
        if (boxes.filter(x => x.type === "mfhd").length !== 1 || boxes.some(x => !["mfhd", "traf"].includes(x.type))) throw new Error("Unsupported fragment side data");
        const runs: CaptureRun[] = []; let previousEnd = moof.at; const intervals: number[][] = [];
        for (const traf of boxes.filter(x => x.type === "traf")) {
            const fields = children(data, traf);
            if (fields.some(x => !["tfhd", "tfdt", "trun"].includes(x.type))) throw new Error("Unsupported track side data");
            const tfhd = fields.find(x => x.type === "tfhd"), tfdt = fields.find(x => x.type === "tfdt"); if (!tfhd || !tfdt) throw new Error("Missing track index");
            if (data[tfdt.at + tfdt.header] > 1) throw new Error("Unsupported timestamp version");
            const f = data.readUIntBE(tfhd.at + tfhd.header + 1, 3), id = data.readUInt32BE(tfhd.at + tfhd.header + 4), track = init.tracks.get(id);
            if (!track || f & 1) throw new Error("Unsupported absolute sample offsets");
            if (runs.some(r => r.track.id === id)) throw new Error("Repeated track fragment");
            let at = tfhd.at + tfhd.header + 8;
            if (f & 2) { if (data.readUInt32BE(at) !== 1) throw new Error("Unsupported sample description"); at += 4; }
            const duration = f & 8 ? data.readUInt32BE(at) : track.duration; if (f & 8) at += 4;
            const size = f & 16 ? data.readUInt32BE(at) : track.size; if (f & 16) at += 4;
            const flags = f & 32 ? data.readUInt32BE(at) : track.flags;
            let dts = data[tfdt.at + tfdt.header] === 1 ? Number(data.readBigUInt64BE(tfdt.at + tfdt.header + 4)) : data.readUInt32BE(tfdt.at + tfdt.header + 4);
            if (!Number.isSafeInteger(dts)) throw new Error("Unsupported decode timestamp");
            const base = f & 0x20000 ? moof.at : previousEnd; let offset = base; const samples: CaptureSample[] = [];
            for (const run of fields.filter(x => x.type === "trun")) {
                const rf = data.readUIntBE(run.at + run.header + 1, 3), count = data.readUInt32BE(run.at + run.header + 4);
                at = run.at + run.header + 8;
                if (rf & 1) { offset = base + data.readInt32BE(at); at += 4; }
                const firstFlags = rf & 4 ? data.readUInt32BE(at) : flags; if (rf & 4) at += 4;
                for (let i = 0; i < count; i++) {
                    const dur = rf & 256 ? data.readUInt32BE(at) : duration; if (rf & 256) at += 4;
                    const n = rf & 512 ? data.readUInt32BE(at) : size; if (rf & 512) at += 4;
                    const sf = rf & 1024 ? data.readUInt32BE(at) : i === 0 ? firstFlags : flags; if (rf & 1024) at += 4;
                    const cto = rf & 2048 ? (data[run.at + run.header] === 1 ? data.readInt32BE(at) : data.readUInt32BE(at)) : 0; if (rf & 2048) at += 4;
                    if (at > run.at + run.size || n <= 0 || dur <= 0 || offset < mdat.at + mdat.header || offset + n > mdat.at + mdat.size) throw new Error("Unsafe sample index");
                    samples.push({ bytes: data.subarray(offset, offset + n), dts, duration: dur, cto, flags: sf });
                    intervals.push([offset, offset + n]); offset += n; dts += dur;
                }
            }
            if (samples.length) runs.push({ track, samples }); previousEnd = offset;
        }
        intervals.sort((a, b) => a[0] - b[0]); let covered = mdat.at + mdat.header;
        for (const [begin, end] of intervals) { if (begin !== covered) throw new Error("Unindexed/overlapping media bytes"); covered = end; }
        if (covered !== mdat.at + mdat.size) throw new Error("Unindexed media tail");
        chunks.push({ sequence: data.readUInt32BE(mfhd.at + mfhd.header + 4), runs, bytes: data.subarray(moof.at, mdat.at + mdat.size) });
    }
    if (!chunks.length) throw new Error("No media fragments"); return chunks;
}
export function avcNals(sample: CaptureSample, lengthBytes: number): Buffer[] {
    const nals: Buffer[] = [];
    for (let at = 0; at < sample.bytes.length;) {
        if (at + lengthBytes > sample.bytes.length) throw new Error("Truncated AVC length");
        const n = sample.bytes.readUIntBE(at, lengthBytes); at += lengthBytes;
        if (!n || at + n > sample.bytes.length) throw new Error("Truncated AVC payload");
        nals.push(sample.bytes.subarray(at, at + n)); at += n;
    }
    return nals;
}
export function initializationAtLevel(init: AvcInitialization, sps: Buffer): Buffer {
    if (sps.length !== init.sps.length || sps.some((v, i) => i !== 3 && v !== init.sps[i])) throw new Error("Unsupported non-level AVC change");
    const bytes = Buffer.from(init.bytes); bytes[init.levelAt] = sps[3]; bytes[init.spsAt + 3] = sps[3]; return bytes;
}
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const box = (name: string, ...parts: Buffer[]) => { const data = Buffer.concat(parts); return Buffer.concat([u32(data.length + 8), Buffer.from(name), data]); };
// Repack only headers/indexes; every encoded sample and its clock is copied verbatim.
export function writeCaptureChunk(sequence: number, runs: CaptureRun[]): Buffer {
    const nonempty = runs.filter(r => r.samples.length), payload = Buffer.concat(nonempty.flatMap(r => r.samples.map(s => s.bytes)));
    const make = (offset: number) => {
        let consumed = 0;
        return box("moof", box("mfhd", u32(0), u32(sequence)), ...nonempty.map(r => {
            const start = offset + consumed; consumed += r.samples.reduce((sum, s) => sum + s.bytes.length, 0);
            return box("traf", box("tfhd", u32(0x20000), u32(r.track.id)), box("tfdt", u32(0x01000000), u64(r.samples[0].dts)),
                box("trun", u32(0x01000f01), u32(r.samples.length), i32(start), ...r.samples.flatMap(s => [u32(s.duration), u32(s.bytes.length), u32(s.flags), i32(s.cto)])));
        }));
    };
    return Buffer.concat([make(make(0).length + 8), box("mdat", payload)]);
}
export function splitCaptureChunk(chunk: CaptureChunk, video: number, cutDts: number): [CaptureChunk, CaptureChunk] {
    const videoRun = chunk.runs.find(r => r.track.id === video);
    const cut = videoRun?.samples.find(s => s.dts === cutDts);
    if (!cut || !videoRun || videoRun.samples.indexOf(cut) <= 0) throw new Error("Split requires an interior video sample");
    const cutSeconds = (cut.dts + cut.cto) / videoRun.track.scale;
    const before: CaptureRun[] = [], after: CaptureRun[] = [];
    for (const run of chunk.runs) {
        let at = run.samples.findIndex(s => s.dts === cutDts);
        if (run.track.id !== video) {
            const times = [...run.samples.map(s => s.dts / run.track.scale), (run.samples.at(-1)!.dts + run.samples.at(-1)!.duration) / run.track.scale];
            at = times.reduce((best, value, i) => Math.abs(value - cutSeconds) < Math.abs(times[best] - cutSeconds) ? i : best, 0);
        }
        before.push({ track: run.track, samples: run.samples.slice(0, at) }); after.push({ track: run.track, samples: run.samples.slice(at) });
    }
    return [before, after].map(runs => ({ sequence: chunk.sequence, runs: runs.filter(r => r.samples.length), bytes: writeCaptureChunk(chunk.sequence, runs) })) as [CaptureChunk, CaptureChunk];
}

export function assertCaptureSamplesPreserved(before: CaptureChunk[], after: CaptureChunk[]): void {
    const tracks = (chunks: CaptureChunk[]) => {
        const result = new Map<number, CaptureSample[]>();
        for (const chunk of chunks) for (const run of chunk.runs) {
            if (!result.has(run.track.id)) result.set(run.track.id, []);
            result.get(run.track.id)!.push(...run.samples);
        }
        return result;
    };
    const original = tracks(before), rewritten = tracks(after);
    if (original.size !== rewritten.size) throw new Error("Lossless split changed track membership");
    for (const [id, samples] of original) {
        const output = rewritten.get(id);
        if (output?.length !== samples.length || samples.some((s, i) => {
            const other = output![i];
            return s.dts !== other.dts || s.duration !== other.duration || s.cto !== other.cto
                || s.flags !== other.flags || !s.bytes.equals(other.bytes);
        })) throw new Error("Lossless split changed an encoded sample or its timing");
    }
}
