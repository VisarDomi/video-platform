// Builds and reads fMP4 fragments (sidx, moof, mdat) for the fragment repair tests.

const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
const i32 = value => { const b = Buffer.alloc(4); b.writeInt32BE(value); return b; };
const u64 = value => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(value)); return b; };
const fullBox = (version, flags) => u32(((version << 24) | flags) >>> 0);
const box = (type, ...parts) => {
    const body = Buffer.concat(parts);
    return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]);
};

// The layout a live fMP4 site serves: a sidx, then a moof whose video run lists each
// sample's duration and size, then the mdat with the samples' bytes.
export function fragment(samples, { tfdt = 1000, trunFlags = 0x301, dataOffsetDelta = 0 } = {}) {
    const entries = samples.flatMap(sample => [
        ...(trunFlags & 0x100 ? [u32(sample.duration)] : []),
        ...(trunFlags & 0x200 ? [u32(sample.bytes.length)] : []),
    ]);
    const moof = dataOffset => box('moof',
        box('mfhd', fullBox(0, 0), u32(7)),
        box('traf',
            box('tfhd', fullBox(0, 0x20000 | 0x8), u32(1), u32(3000)),
            box('tfdt', fullBox(1, 0), u64(tfdt)),
            box('trun', fullBox(0, trunFlags), u32(samples.length), i32(dataOffset), ...entries)));
    const moofBox = moof(moof(0).length + 8 + dataOffsetDelta);
    const mdat = box('mdat', ...samples.map(sample => sample.bytes));
    const duration = samples.reduce((sum, sample) => sum + sample.duration, 0);
    const sidx = box('sidx', fullBox(1, 0), u32(1), u32(90000), u64(tfdt), u64(0), u32(1),
        u32(moofBox.length + mdat.length), u32(duration), u32(0x90000000));
    return Buffer.concat([sidx, moofBox, mdat]);
}

// Reads the fragment back independently of the code under test.
export function read(data) {
    const boxes = [];
    for (let offset = 0; offset < data.length;) {
        const size = data.readUInt32BE(offset);
        boxes.push({ type: data.toString('latin1', offset + 4, offset + 8), start: offset, size });
        offset += size;
    }
    const sidx = boxes.find(b => b.type === 'sidx');
    const moof = boxes.find(b => b.type === 'moof');
    const mdat = boxes.find(b => b.type === 'mdat');
    const traf = moof.start + 8 + 16;
    const tfhdSize = data.readUInt32BE(traf + 8);
    const tfdtAt = traf + 8 + tfhdSize;
    const trun = tfdtAt + data.readUInt32BE(tfdtAt);
    const count = data.readUInt32BE(trun + 12);
    let at = moof.start + data.readInt32BE(trun + 16);
    const samples = [];
    for (let i = 0; i < count; i++) {
        const duration = data.readUInt32BE(trun + 20 + i * 8);
        const size = data.readUInt32BE(trun + 24 + i * 8);
        samples.push({ duration, bytes: data.subarray(at, at + size).toString() });
        at += size;
    }
    return {
        tfdt: Number(data.readBigUInt64BE(tfdtAt + 12)),
        samples,
        mdat: data.subarray(mdat.start, mdat.start + mdat.size),
        sidxReferencedSize: data.readUInt32BE(sidx.start + 40) & 0x7fffffff,
        moofAndMdat: moof.size + mdat.size,
        boxesEndAtFileEnd: boxes.reduce((sum, b) => sum + b.size, 0) === data.length,
    };
}

export const sample = (duration, text) => ({ duration, bytes: Buffer.from(text) });
