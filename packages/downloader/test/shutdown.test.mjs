import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('no session starts once shutdown has begun', async (t) => {
    // The status file lives under $HOME; keep it out of the real one.
    const home = await mkdtemp(path.join(os.tmpdir(), 'downloader-home-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    process.env.HOME = home;
    const { DownloadsManager } = await import('../dist/services/state/downloadsManager.js');
    const manager = await DownloadsManager.create();

    const before = manager.add('https://example.test/a/master.m3u8', { streamerId: 'a', alias: 'a', recordingId: 'ra' });
    assert.ok(before);
    before.remove();
    await manager.shutdownAll();
    assert.equal(manager.add('https://example.test/b/master.m3u8', { streamerId: 'b', alias: 'b', recordingId: 'rb' }), null);
});
