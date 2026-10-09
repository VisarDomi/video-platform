import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dropZeroSizeSamples, inspectFragment } from '../dist/services/download/fmp4Fragment.js';
import { ScClient } from '../dist/services/sc/api/scClient.js';

const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
const i32 = value => { const b = Buffer.alloc(4); b.writeInt32BE(value); return b; };
const u64 = value => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(value)); return b; };
const fullBox = (version, flags) => u32(((version << 24) | flags) >>> 0);
const box = (type, ...parts) => {
    const body = Buffer.concat(parts);
    return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]);
};

// The layout SC serves: a sidx, then a moof whose video run lists each
// sample's duration and size, then the mdat with the samples' bytes.
function fragment(samples, { tfdt = 1000, trunFlags = 0x301, dataOffsetDelta = 0 } = {}) {
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
function read(data) {
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

const sample = (duration, text) => ({ duration, bytes: Buffer.from(text) });

test('a zero-size frame entry is dropped; its duration goes to the frame before and no media byte changes', () => {
    const original = fragment([sample(3000, 'aaaa'), sample(3000, ''), sample(3000, 'cccc')]);
    assert.deepEqual(inspectFragment(original), { zeroSizeSamples: 1, problem: null });
    const repair = dropZeroSizeSamples(original);
    assert.equal(repair.droppedSamples, 1);
    const before = read(original), after = read(repair.data);
    assert.deepEqual(after.samples, [{ duration: 6000, bytes: 'aaaa' }, { duration: 3000, bytes: 'cccc' }]);
    assert.equal(after.tfdt, before.tfdt);
    assert.deepEqual(after.mdat, before.mdat);
    assert.equal(after.sidxReferencedSize, after.moofAndMdat);
    assert.equal(after.boxesEndAtFileEnd, true);
    assert.deepEqual(inspectFragment(repair.data), { zeroSizeSamples: 0, problem: null });
});

test('a zero-size first frame moves the run start by its duration instead', () => {
    const repair = dropZeroSizeSamples(fragment([sample(3000, ''), sample(3000, 'bbbb'), sample(3000, 'cccc')], { tfdt: 5000 }));
    const after = read(repair.data);
    assert.equal(after.tfdt, 8000);
    assert.deepEqual(after.samples, [{ duration: 3000, bytes: 'bbbb' }, { duration: 3000, bytes: 'cccc' }]);
    assert.deepEqual(inspectFragment(repair.data), { zeroSizeSamples: 0, problem: null });
});

test('an intact fragment needs no repair', () => {
    const original = fragment([sample(3000, 'aaaa'), sample(3000, 'bbbb')]);
    assert.deepEqual(inspectFragment(original), { zeroSizeSamples: 0, problem: null });
    assert.equal(dropZeroSizeSamples(original), null);
});

test('sample data outside its mdat is a problem no repair can fix', () => {
    const broken = fragment([sample(3000, 'aaaa'), sample(3000, 'bbbb')], { dataOffsetDelta: 4 });
    assert.match(inspectFragment(broken).problem, /outside its mdat/);
    assert.equal(dropZeroSizeSamples(broken), null);
});

test('a run without per-sample durations is not rewritten', () => {
    const original = fragment([sample(3000, 'aaaa'), sample(3000, '')], { trunFlags: 0x201 });
    assert.equal(inspectFragment(original).zeroSizeSamples, 1);
    assert.equal(dropZeroSizeSamples(original), null);
});

test('the SC session repairs a fragment as it arrives and says what it dropped', async (t) => {
    const original = fragment([sample(3000, 'aaaa'), sample(3000, ''), sample(3000, 'cccc')]);
    t.mock.method(globalThis, 'fetch', async () => new Response(original));
    const result = await new ScClient().createDownloadSession().fetchSegment('https://example.test/s.m4s');
    assert.deepEqual(read(result.data).samples, [{ duration: 6000, bytes: 'aaaa' }, { duration: 3000, bytes: 'cccc' }]);
    assert.match(result.repair, /dropped 1 zero-size sample entr/);
});

test('SC validation rejects a fragment whose index is damaged beyond repair', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fmp4-fragment-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sc = new ScClient();
    const write = async (name, data) => { const file = path.join(root, name); await writeFile(file, data); return file; };
    assert.equal((await sc.validateSegment(await write('ok.m4s', fragment([sample(3000, 'aaaa')])))).valid, true);
    assert.equal((await sc.validateSegment(await write('outside.m4s',
        fragment([sample(3000, 'aaaa')], { dataOffsetDelta: 4 })))).valid, false);
    assert.equal((await sc.validateSegment(await write('zero.m4s',
        fragment([sample(3000, 'aaaa'), sample(3000, '')], { trunFlags: 0x201 })))).valid, false);
});
