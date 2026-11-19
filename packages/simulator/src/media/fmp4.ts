// ISO-BMFF (fMP4/CMAF) edits the simulator applies while serving: moving a
// fragment's decode times, and inserting a zero-size sample entry (the index
// damage a stalled source leaves behind, which clients must repair).

export interface Box {
    type: string;
    start: number;
    size: number;
}

export interface TrackInfo {
    id: number;
    timescale: number;
    handler: string;
}

export function readBoxes(data: Buffer, start = 0, end = data.length): Box[] {
    const boxes: Box[] = [];
    for (let at = start; at + 8 <= end;) {
        let size = data.readUInt32BE(at);
        if (size === 0) size = end - at;
        if (size < 8 || at + size > end) throw new RangeError(`box at ${at} exceeds its parent`);
        boxes.push({ type: data.toString("latin1", at + 4, at + 8), start: at, size });
        at += size;
    }
    return boxes;
}

const children = (data: Buffer, box: Box) => readBoxes(data, box.start + 8, box.start + box.size);
const child = (data: Buffer, box: Box, type: string) => children(data, box).find(b => b.type === type);

/** Track IDs, timescales and handler types from an init segment's moov. */
export function trackInfo(init: Buffer): TrackInfo[] {
    const moov = readBoxes(init).find(b => b.type === "moov");
    if (!moov) throw new Error("init segment has no moov");
    return children(init, moov).filter(b => b.type === "trak").map(trak => {
        const tkhd = child(init, trak, "tkhd")!;
        const id = init.readUInt32BE(tkhd.start + (init[tkhd.start + 8] === 1 ? 28 : 20));
        const mdia = child(init, trak, "mdia")!;
        const mdhd = child(init, mdia, "mdhd")!;
        const timescale = init.readUInt32BE(mdhd.start + (init[mdhd.start + 8] === 1 ? 28 : 20));
        const hdlr = child(init, mdia, "hdlr")!;
        return { id, timescale, handler: init.toString("latin1", hdlr.start + 16, hdlr.start + 20) };
    });
}

/**
 * Returns a copy whose tfdt and sidx times are moved by `deltaSeconds`,
 * converted to each track's timescale, and whose fragment sequence number
 * is moved by `sequenceDelta`.
 */
export function shiftFragment(input: Buffer, deltaSeconds: number, tracks: TrackInfo[], sequenceDelta = 0): Buffer {
    const data = Buffer.from(input);
    if (deltaSeconds === 0 && sequenceDelta === 0) return data;
    const timescaleOf = new Map(tracks.map(t => [t.id, t.timescale]));
    for (const box of readBoxes(data)) {
        if (box.type === "sidx") {
            const version = data[box.start + 8];
            const timescale = data.readUInt32BE(box.start + 16);
            const at = box.start + 20;
            const delta = Math.round(deltaSeconds * timescale);
            if (version === 1) data.writeBigUInt64BE(data.readBigUInt64BE(at) + BigInt(delta), at);
            else data.writeUInt32BE((data.readUInt32BE(at) + delta) >>> 0, at);
        } else if (box.type === "moof") {
            const mfhd = child(data, box, "mfhd");
            if (mfhd && sequenceDelta) data.writeUInt32BE((data.readUInt32BE(mfhd.start + 12) + sequenceDelta) >>> 0, mfhd.start + 12);
            for (const traf of children(data, box).filter(b => b.type === "traf")) {
                const tfhd = child(data, traf, "tfhd");
                const tfdt = child(data, traf, "tfdt");
                if (!tfhd || !tfdt) continue;
                const timescale = timescaleOf.get(data.readUInt32BE(tfhd.start + 12));
                if (!timescale) continue;
                const delta = Math.round(deltaSeconds * timescale);
                const at = tfdt.start + 12;
                if (data[tfdt.start + 8] === 1) data.writeBigUInt64BE(data.readBigUInt64BE(at) + BigInt(delta), at);
                else data.writeUInt32BE((data.readUInt32BE(at) + delta) >>> 0, at);
            }
        }
    }
    return data;
}

const TFHD_BASE_DATA_OFFSET = 0x1;
const TFHD_SAMPLE_DESCRIPTION_INDEX = 0x2;
const TFHD_DEFAULT_DURATION = 0x8;
const TFHD_DEFAULT_SIZE = 0x10;
const TRUN_DATA_OFFSET = 0x1;
const TRUN_FIRST_SAMPLE_FLAGS = 0x4;
const TRUN_DURATION = 0x100;
const TRUN_SIZE = 0x200;
const TRUN_FLAGS = 0x400;
const TRUN_COMPOSITION_OFFSET = 0x800;
const NON_SYNC_SAMPLE_FLAGS = 0x01010000;

interface RunEntry { duration: number; size: number; flags: number; cto: number }

function u32(value: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(value >>> 0);
    return b;
}

function withSize(box: Buffer): Buffer {
    box.writeUInt32BE(box.length, 0);
    return box;
}

/**
 * Inserts one zero-size sample entry into the video track run of the first
 * moof, splitting the duration of the sample before it so the fragment's
 * total duration is unchanged. Media bytes are untouched; box sizes, data
 * offsets and sidx references are adjusted. Returns null when the layout is
 * not one this rewrites.
 */
export function insertZeroSizeSample(input: Buffer, tracks: TrackInfo[]): Buffer | null {
    const videoId = tracks.find(t => t.handler === "vide")?.id;
    const top = readBoxes(input);
    const moofIndex = top.findIndex(b => b.type === "moof");
    if (moofIndex < 0 || videoId === undefined) return null;
    const moof = top[moofIndex];
    const trafs = children(input, moof).filter(b => b.type === "traf");
    const traf = trafs.find(t => {
        const tfhd = child(input, t, "tfhd");
        return tfhd !== undefined && input.readUInt32BE(tfhd.start + 12) === videoId;
    });
    if (!traf) return null;
    const tfhd = child(input, traf, "tfhd")!;
    const trun = child(input, traf, "trun");
    if (!trun) return null;

    const tfhdFlags = input.readUIntBE(tfhd.start + 9, 3);
    if (tfhdFlags & TFHD_BASE_DATA_OFFSET) return null;
    let at = tfhd.start + 16;
    if (tfhdFlags & TFHD_SAMPLE_DESCRIPTION_INDEX) at += 4;
    const defaultDuration = tfhdFlags & TFHD_DEFAULT_DURATION ? input.readUInt32BE(at) : null;
    if (tfhdFlags & TFHD_DEFAULT_DURATION) at += 4;
    const defaultSize = tfhdFlags & TFHD_DEFAULT_SIZE ? input.readUInt32BE(at) : null;

    const version = input[trun.start + 8];
    const flags = input.readUIntBE(trun.start + 9, 3);
    const count = input.readUInt32BE(trun.start + 12);
    let p = trun.start + 16;
    const dataOffset = flags & TRUN_DATA_OFFSET ? input.readInt32BE(p) : null;
    if (flags & TRUN_DATA_OFFSET) p += 4;
    const firstFlags = flags & TRUN_FIRST_SAMPLE_FLAGS ? input.readUInt32BE(p) : null;
    if (flags & TRUN_FIRST_SAMPLE_FLAGS) p += 4;
    if (dataOffset === null || count === 0) return null;
    if (!(flags & TRUN_DURATION) && defaultDuration === null) return null;
    if (!(flags & TRUN_SIZE) && defaultSize === null) return null;

    const entries: RunEntry[] = [];
    for (let i = 0; i < count; i++) {
        const entry: RunEntry = { duration: defaultDuration ?? 0, size: defaultSize ?? 0, flags: NON_SYNC_SAMPLE_FLAGS, cto: 0 };
        if (flags & TRUN_DURATION) { entry.duration = input.readUInt32BE(p); p += 4; }
        if (flags & TRUN_SIZE) { entry.size = input.readUInt32BE(p); p += 4; }
        if (flags & TRUN_FLAGS) { entry.flags = input.readUInt32BE(p); p += 4; }
        if (flags & TRUN_COMPOSITION_OFFSET) { entry.cto = input.readUInt32BE(p); p += 4; }
        entries.push(entry);
    }

    const before = Math.min(1, count - 1);
    const split = Math.floor(entries[before].duration / 2);
    if (split === 0) return null;
    entries[before].duration -= split;
    entries.splice(before + 1, 0, { duration: split, size: 0, flags: NON_SYNC_SAMPLE_FLAGS, cto: entries[before].cto });

    const newFlags = flags | TRUN_DURATION | TRUN_SIZE;
    const head = Buffer.concat([
        Buffer.from([0, 0, 0, 0]), Buffer.from("trun", "latin1"),
        u32(((version << 24) | newFlags) >>> 0), u32(entries.length),
        u32(0), // data offset, patched below
        ...(firstFlags === null ? [] : [u32(firstFlags)]),
    ]);
    const body = Buffer.concat(entries.map(e => Buffer.concat([
        u32(e.duration), u32(e.size),
        ...(newFlags & TRUN_FLAGS ? [u32(e.flags)] : []),
        ...(newFlags & TRUN_COMPOSITION_OFFSET ? [u32(e.cto)] : []),
    ])));
    const newTrun = withSize(Buffer.concat([head, body]));
    const growth = newTrun.length - trun.size;

    // Every run's data offset is relative to the moof start (default-base-is-moof)
    // and the mdat moves by `growth`.
    const rebuildTraf = (t: Box): Buffer => withSize(Buffer.concat([
        input.subarray(t.start, t.start + 8),
        ...children(input, t).map(b => {
            const isTarget = b.start === trun.start;
            const bytes = isTarget ? Buffer.from(newTrun) : Buffer.from(input.subarray(b.start, b.start + b.size));
            if (b.type === "trun") {
                const runFlags = bytes.readUIntBE(9, 3);
                if (runFlags & TRUN_DATA_OFFSET) {
                    const original = isTarget ? dataOffset : input.readInt32BE(b.start + 16);
                    bytes.writeInt32BE(original + growth, 16);
                }
            }
            return bytes;
        }),
    ]));
    const newMoof = withSize(Buffer.concat([
        input.subarray(moof.start, moof.start + 8),
        ...children(input, moof).map(b => b.type === "traf" ? rebuildTraf(b) : input.subarray(b.start, b.start + b.size)),
    ]));

    const parts: Buffer[] = [];
    top.forEach((box, index) => {
        if (index === moofIndex) { parts.push(newMoof); return; }
        const bytes = Buffer.from(input.subarray(box.start, box.start + box.size));
        if (box.type === "sidx" && index < moofIndex) {
            const countAt = 8 + 4 + 8 + (bytes[8] === 1 ? 16 : 8) + 2;
            const references = bytes.readUInt16BE(countAt);
            if (references >= 1) {
                const reference = bytes.readUInt32BE(countAt + 2);
                bytes.writeUInt32BE(((reference & 0x80000000) | ((reference & 0x7fffffff) + growth)) >>> 0, countAt + 2);
            }
        }
        parts.push(bytes);
    });
    return Buffer.concat(parts);
}

/** Counts zero-size sample entries in every track run (a check for tests). */
export function countZeroSizeSamples(data: Buffer): number {
    let zero = 0;
    for (const moof of readBoxes(data).filter(b => b.type === "moof")) {
        for (const traf of children(data, moof).filter(b => b.type === "traf")) {
            for (const trun of children(data, traf).filter(b => b.type === "trun")) {
                const flags = data.readUIntBE(trun.start + 9, 3);
                if (!(flags & TRUN_SIZE)) continue;
                const count = data.readUInt32BE(trun.start + 12);
                let p = trun.start + 16 + (flags & TRUN_DATA_OFFSET ? 4 : 0) + (flags & TRUN_FIRST_SAMPLE_FLAGS ? 4 : 0);
                const entry = 4 * [TRUN_DURATION, TRUN_SIZE, TRUN_FLAGS, TRUN_COMPOSITION_OFFSET].filter(f => flags & f).length;
                const sizeAt = flags & TRUN_DURATION ? 4 : 0;
                for (let i = 0; i < count; i++, p += entry) if (data.readUInt32BE(p + sizeAt) === 0) zero++;
            }
        }
    }
    return zero;
}
