import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The status file lives under $HOME; keep it out of the real one.
const home = await mkdtemp(path.join(os.tmpdir(), 'downloads-manager-'));
process.env.HOME = home;
test.after(() => rm(home, { recursive: true, force: true }));
const { DownloadsManager } = await import('../dist/services/state/downloadsManager.js');

test("a streamer's recording identity can be asked for one site only", async () => {
    const manager = await DownloadsManager.create();
    const start = (url, provider, streamerId, recordingId) => {
        const handle = manager.add(url, { streamerId, alias: streamerId, recordingId });
        manager.registerDownloader(url, provider, streamerId, () => {}, () => {}, new Promise(() => {}));
        return handle;
    };
    start('https://cdn.example.test/a/master.m3u8', 'site-a', '123', 'ra');
    assert.equal(manager.getRecordingId('123'), 'ra');
    assert.equal(manager.getRecordingId('123', 'site-a'), 'ra');
    assert.equal(manager.getRecordingId('123', 'site-b'), null);
    assert.equal(manager.getRecordingId('456', 'site-a'), null);
});
