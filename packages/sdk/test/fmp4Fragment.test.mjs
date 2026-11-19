import assert from 'node:assert/strict';
import test from 'node:test';
import { dropZeroSizeSamples, inspectFragment } from '../dist/index.js';
import { fragment, read, sample } from './helpers/fmp4Fixture.mjs';

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
