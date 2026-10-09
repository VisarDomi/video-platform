// Reads and repairs the index of an fMP4 media fragment (sidx, moof, mdat).
//
// A source stall can leave a sample entry of zero bytes in a fragment's index:
// an empty video frame. ffmpeg refuses such a fragment, and Safari stops
// playback ("Cannot Parse") as soon as it reads that far ahead. The entry
// carries no media, so dropping it keeps every byte the provider sent.

interface Box {
    type: string;
    start: number;
    size: number;
}

function readBoxes(data: Buffer, start: number, end: number): Box[] | null {
    const boxes: Box[] = [];
    for (let offset = start; offset < end;) {
        if (offset + 8 > end) return null;
        const size = data.readUInt32BE(offset);
        // Large (64-bit) and to-end sizes never occur in these indexes.
        if (size < 8 || offset + size > end) return null;
        boxes.push({ type: data.toString("latin1", offset + 4, offset + 8), start: offset, size });
        offset += size;
    }
    return boxes;
}

const TFHD_BASE_DATA_OFFSET = 0x1;
const TFHD_SAMPLE_DESCRIPTION_INDEX = 0x2;
const TFHD_DEFAULT_DURATION = 0x8;
const TFHD_DEFAULT_SIZE = 0x10;
const TFHD_DEFAULT_BASE_IS_MOOF = 0x20000;
const TRUN_DATA_OFFSET = 0x1;
const TRUN_FIRST_SAMPLE_FLAGS = 0x4;
const TRUN_DURATION = 0x100;
const TRUN_SIZE = 0x200;
const TRUN_FLAGS = 0x400;
const TRUN_COMPOSITION_OFFSET = 0x800;

const flagsOf = (data: Buffer, box: Box) => data.readUIntBE(box.start + 9, 3);

interface TrackRun {
    box: Box;
    flags: number;
    dataOffset: number | null;
    entriesStart: number;
    entrySize: number;
    // null when sizes come from the init segment's defaults.
    sizes: number[] | null;
    durations: number[] | null;
}

function readTrackRun(data: Buffer, box: Box, defaultSize: number | null): TrackRun {
    const flags = flagsOf(data, box);
    const count = data.readUInt32BE(box.start + 12);
    let at = box.start + 16;
    let dataOffset: number | null = null;
    if (flags & TRUN_DATA_OFFSET) { dataOffset = data.readInt32BE(at); at += 4; }
    if (flags & TRUN_FIRST_SAMPLE_FLAGS) at += 4;
    const entrySize = 4 * [TRUN_DURATION, TRUN_SIZE, TRUN_FLAGS, TRUN_COMPOSITION_OFFSET].filter(f => flags & f).length;
    if (at + count * entrySize > box.start + box.size) throw new RangeError("trun entries exceed the box");
    const field = (index: number, flag: number) => {
        let offset = at + index * entrySize;
        if (flag !== TRUN_DURATION && flags & TRUN_DURATION) offset += 4;
        return data.readUInt32BE(offset);
    };
    const indexes = Array.from({ length: count }, (_, i) => i);
    return {
        box, flags, dataOffset, entriesStart: at, entrySize,
        sizes: flags & TRUN_SIZE ? indexes.map(i => field(i, TRUN_SIZE))
            : defaultSize === null ? null : indexes.map(() => defaultSize),
        durations: flags & TRUN_DURATION ? indexes.map(i => field(i, TRUN_DURATION)) : null,
    };
}

interface TrackHeader {
    flags: number;
    defaultSize: number | null;
}

function readTrackHeader(data: Buffer, box: Box): TrackHeader {
    const flags = flagsOf(data, box);
    let at = box.start + 16;
    if (flags & TFHD_BASE_DATA_OFFSET) at += 8;
    if (flags & TFHD_SAMPLE_DESCRIPTION_INDEX) at += 4;
    if (flags & TFHD_DEFAULT_DURATION) at += 4;
    return { flags, defaultSize: flags & TFHD_DEFAULT_SIZE ? data.readUInt32BE(at) : null };
}

export interface FragmentInspection {
    zeroSizeSamples: number;
    // Index damage no repair here can fix; null when there is none.
    problem: string | null;
}

// An init segment (ftyp/moov) has no moof and inspects clean.
export function inspectFragment(data: Buffer): FragmentInspection {
    try {
        const top = readBoxes(data, 0, data.length);
        if (!top) return { zeroSizeSamples: 0, problem: "a box exceeds the fragment" };
        let zeroSizeSamples = 0;
        for (let index = 0; index < top.length; index++) {
            const moof = top[index];
            if (moof.type !== "moof") continue;
            const mdat = top[index + 1];
            if (mdat?.type !== "mdat") return { zeroSizeSamples, problem: "a moof is not followed by its mdat" };
            const children = readBoxes(data, moof.start + 8, moof.start + moof.size);
            if (!children) return { zeroSizeSamples, problem: "a moof box exceeds its moof" };
            let previousTrackEnd = moof.start;
            for (const traf of children.filter(child => child.type === "traf")) {
                const boxes = readBoxes(data, traf.start + 8, traf.start + traf.size);
                const tfhd = boxes?.find(child => child.type === "tfhd");
                if (!boxes || !tfhd) return { zeroSizeSamples, problem: "a traf has no readable tfhd" };
                const header = readTrackHeader(data, tfhd);
                // An explicit base offset points into the file, not the moof.
                if (header.flags & TFHD_BASE_DATA_OFFSET) continue;
                const base = header.flags & TFHD_DEFAULT_BASE_IS_MOOF ? moof.start : previousTrackEnd;
                let runEnd = base;
                for (const trunBox of boxes.filter(child => child.type === "trun")) {
                    const run = readTrackRun(data, trunBox, header.defaultSize);
                    if (!run.sizes) continue;
                    zeroSizeSamples += run.sizes.filter(size => size === 0).length;
                    const start = run.dataOffset === null ? runEnd : base + run.dataOffset;
                    runEnd = start + run.sizes.reduce((sum, size) => sum + size, 0);
                    if (start < mdat.start + 8 || runEnd > mdat.start + mdat.size) {
                        return { zeroSizeSamples, problem: "sample data lies outside its mdat" };
                    }
                }
                previousTrackEnd = runEnd;
            }
        }
        return { zeroSizeSamples, problem: null };
    } catch (error) {
        if (error instanceof RangeError) return { zeroSizeSamples: 0, problem: "the index is truncated" };
        throw error;
    }
}

export interface FragmentRepair {
    data: Buffer;
    droppedSamples: number;
}

// Drops zero-size sample entries: each one's duration goes to the sample
// before it, or moves the track's start (tfdt) when it is the first. Box
// sizes, the moof-relative data offsets and the sidx references are adjusted;
// the media bytes are unchanged. Returns null when nothing needs repair or the
// layout is one this does not rewrite (the fragment is then left as it is).
export function dropZeroSizeSamples(data: Buffer): FragmentRepair | null {
    const inspection = inspectFragment(data);
    if (inspection.problem !== null || inspection.zeroSizeSamples === 0) return null;
    const top = readBoxes(data, 0, data.length)!;
    const parts: Buffer[] = [];
    let pendingSidx: Buffer[] = [];
    let droppedSamples = 0;
    for (const box of top) {
        const bytes = data.subarray(box.start, box.start + box.size);
        if (box.type === "sidx") { pendingSidx.push(Buffer.from(bytes)); continue; }
        if (box.type !== "moof") { parts.push(...pendingSidx, bytes); pendingSidx = []; continue; }
        const rebuilt = rebuildMoof(data, box);
        if (rebuilt === null) return null;
        if (rebuilt.removedBytes > 0) {
            for (const sidx of pendingSidx) if (!shrinkSidxReference(sidx, rebuilt.removedBytes)) return null;
        }
        droppedSamples += rebuilt.droppedSamples;
        parts.push(...pendingSidx, rebuilt.moof);
        pendingSidx = [];
    }
    parts.push(...pendingSidx);
    const repaired = Buffer.concat(parts);
    const check = inspectFragment(repaired);
    if (check.problem !== null || check.zeroSizeSamples !== 0) return null;
    return { data: repaired, droppedSamples };
}

function shrinkSidxReference(sidx: Buffer, removedBytes: number): boolean {
    const version = sidx[8];
    const countAt = 8 + 4 + 8 + (version === 1 ? 16 : 8) + 2;
    if (countAt + 2 + 12 > sidx.length || sidx.readUInt16BE(countAt) !== 1) return false;
    const reference = sidx.readUInt32BE(countAt + 2);
    const size = (reference & 0x7fffffff) - removedBytes;
    if (size <= 0) return false;
    sidx.writeUInt32BE(((reference & 0x80000000) | size) >>> 0, countAt + 2);
    return true;
}

function sizedBox(header: Buffer, children: Buffer[]): Buffer {
    const box = Buffer.concat([header, ...children]);
    box.writeUInt32BE(box.length, 0);
    return box;
}

function rebuildMoof(data: Buffer, moof: Box): { moof: Buffer; removedBytes: number; droppedSamples: number } | null {
    const children = readBoxes(data, moof.start + 8, moof.start + moof.size)!;
    const tracks = children.filter(child => child.type === "traf").map(traf => {
        const boxes = readBoxes(data, traf.start + 8, traf.start + traf.size)!;
        const header = readTrackHeader(data, boxes.find(box => box.type === "tfhd")!);
        const runs = boxes.filter(box => box.type === "trun").map(box => readTrackRun(data, box, header.defaultSize));
        return { traf, boxes, header, runs };
    });
    if (!tracks.some(track => track.runs.some(run => run.sizes?.includes(0)))) {
        return { moof: data.subarray(moof.start, moof.start + moof.size), removedBytes: 0, droppedSamples: 0 };
    }
    // Shrinking the moof moves its mdat, so every run's data must be addressed
    // from the moof start for the offsets to be adjusted.
    const moofRelative = tracks.every(({ header, runs }) => header.flags & TFHD_DEFAULT_BASE_IS_MOOF
        && !(header.flags & TFHD_BASE_DATA_OFFSET) && runs.every(run => run.dataOffset !== null));
    if (!moofRelative) return null;

    let removedBytes = 0;
    let droppedSamples = 0;
    const rebuiltRuns = new Map<number, Buffer>();
    const tfdtShifts = new Map<number, number>();
    for (const { traf, runs } of tracks) {
        for (const [runIndex, run] of runs.entries()) {
            if (!run.sizes?.includes(0)) continue;
            if (!(run.flags & TRUN_SIZE) || !run.durations) return null;
            const durations = [...run.durations];
            const kept: number[] = [];
            for (let i = 0; i < run.sizes.length; i++) {
                if (run.sizes[i] !== 0) { kept.push(i); continue; }
                droppedSamples++;
                if (kept.length > 0) durations[kept.at(-1)!] += durations[i];
                else if (runIndex === 0) tfdtShifts.set(traf.start, (tfdtShifts.get(traf.start) ?? 0) + durations[i]);
                else return null;
            }
            if (kept.length === 0) return null;
            removedBytes += (run.sizes.length - kept.length) * run.entrySize;
            const rebuilt = Buffer.concat([
                data.subarray(run.box.start, run.entriesStart),
                ...kept.map(i => data.subarray(run.entriesStart + i * run.entrySize, run.entriesStart + (i + 1) * run.entrySize)),
            ]);
            rebuilt.writeUInt32BE(rebuilt.length, 0);
            rebuilt.writeUInt32BE(kept.length, 12);
            kept.forEach((i, position) => rebuilt.writeUInt32BE(durations[i], run.entriesStart - run.box.start + position * run.entrySize));
            rebuiltRuns.set(run.box.start, rebuilt);
        }
    }

    const moofParts: Buffer[] = [];
    for (const child of children) {
        const track = tracks.find(candidate => candidate.traf.start === child.start);
        if (!track) { moofParts.push(data.subarray(child.start, child.start + child.size)); continue; }
        const trafParts: Buffer[] = [];
        for (const box of track.boxes) {
            let bytes = rebuiltRuns.get(box.start) ?? Buffer.from(data.subarray(box.start, box.start + box.size));
            if (box.type === "trun") {
                // With the moof as base, the data sits removedBytes closer.
                bytes.writeInt32BE(bytes.readInt32BE(16) - removedBytes, 16);
            }
            const shift = box.type === "tfdt" ? tfdtShifts.get(track.traf.start) ?? 0 : 0;
            if (shift > 0) {
                if (bytes[8] === 1) bytes.writeBigUInt64BE(bytes.readBigUInt64BE(12) + BigInt(shift), 12);
                else if (bytes.readUInt32BE(12) + shift <= 0xffffffff) bytes.writeUInt32BE(bytes.readUInt32BE(12) + shift, 12);
                else return null;
                tfdtShifts.delete(track.traf.start);
            }
            trafParts.push(bytes);
        }
        // A first sample was dropped but the track has no tfdt to move.
        if (tfdtShifts.has(track.traf.start)) return null;
        moofParts.push(sizedBox(data.subarray(track.traf.start, track.traf.start + 8), trafParts));
    }
    return { moof: sizedBox(data.subarray(moof.start, moof.start + 8), moofParts), removedBytes, droppedSamples };
}
