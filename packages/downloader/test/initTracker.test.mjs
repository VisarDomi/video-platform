import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DiskSession } from '../dist/services/download/diskSession.js';
import { InitTracker, InitWriteError } from '../dist/services/download/initTracker.js';

const handle = () => ({ state: { alias: 'example' }, update(value) { Object.assign(this.state, value); } });
const init = (content = 'init') => async () => ({ data: Buffer.from(content) });

test('a taken init name moves on to the next free one', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'init-tracker-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const tracker = new InitTracker(new DiskSession('example', handle(), async () => root));
    assert.deepEqual(await tracker.commitInit('a.mp4', init('init-a'), 1), { fileName: 'init.mp4', isQualityChange: false });
    await writeFile(path.join(root, 'init_7.mp4'), 'taken');
    assert.deepEqual(await tracker.commitInit('b.mp4', init('init-b'), 7), { fileName: 'init_7_1.mp4', isQualityChange: true });
});

test('identical init bytes under a new map URL reuse the active init file without writing a duplicate', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'init-tracker-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const tracker = new InitTracker(new DiskSession('example', handle(), async () => root));
    assert.deepEqual(await tracker.commitInit('edge-1/init.mp4', init('same-init'), 0), { fileName: 'init.mp4', isQualityChange: false });
    assert.equal(await tracker.stageInit('edge-2/init.mp4', init('same-init')), 'unchanged');
    assert.equal(await tracker.flushPendingInit(5), null);
    assert.equal(tracker.needsUpdate('edge-2/init.mp4'), false);
    assert.deepEqual(await readdir(root), ['init.mp4']);
});

test('a staged init map is not written to disk until flushed for a segment', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'init-tracker-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const tracker = new InitTracker(new DiskSession('example', handle(), async () => root));
    assert.equal(await tracker.stageInit('a.mp4', init('init-a')), 'staged');
    assert.deepEqual(await readdir(root), []);
    assert.deepEqual(await tracker.flushPendingInit(0), { fileName: 'init.mp4', isQualityChange: false });
    assert.deepEqual(await readdir(root), ['init.mp4']);
});

test('an init write into a folder that is gone fails at once instead of trying other names', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'init-tracker-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const gone = path.join(root, 'moved-away');
    const disk = new DiskSession('example', handle(), async () => gone, gone);
    assert.equal(await disk.present(), false);
    await assert.rejects(new InitTracker(disk).commitInit('a.mp4', init('init-a'), 1), InitWriteError);
    assert.deepEqual(await readdir(root), []);
});
