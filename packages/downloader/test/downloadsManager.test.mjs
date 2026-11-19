import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The status file lives under $HOME; keep it out of the real one. The recording folders
// live under the downloads root.
const home = await mkdtemp(path.join(os.tmpdir(), 'downloads-manager-'));
process.env.HOME = home;
process.env.VIDEO_DOWNLOADS_ROOT = path.join(home, 'downloads');
// The status file is written 200 ms after the last change; let that write finish first.
test.after(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await rm(home, { recursive: true, force: true });
});
const { DownloadsManager } = await import('../dist/services/state/downloadsManager.js');
const { ActiveRecordingReconciler } = await import('../dist/services/common/activeRecordingReconciler.js');

// A registered capture whose finalize ends it, as a StreamSession does.
function capture(manager, url, provider, streamerId, recordingId) {
    const handle = manager.add(url, { streamerId, alias: streamerId, recordingId }, provider);
    assert.ok(handle);
    const ended = [];
    let done;
    const completion = new Promise((resolve) => { done = resolve; });
    manager.registerDownloader(url, provider, streamerId, () => {}, (reason) => {
        ended.push(reason);
        handle.remove();
        done();
    }, completion);
    return ended;
}

test('the same numeric ID on two sites: every lookup and every ending is per site', async () => {
    const manager = await DownloadsManager.create();
    const onA = capture(manager, 'https://cdn-a.example.test/123/master.m3u8', 'site-a', '123', 'ra');
    const onB = capture(manager, 'https://cdn-b.example.test/123/master.m3u8', 'site-b', '123', 'rb');

    assert.equal(manager.getRecordingId('123', 'site-a'), 'ra');
    assert.equal(manager.getRecordingId('123', 'site-b'), 'rb');
    assert.equal(manager.getRecordingId('123', 'site-c'), null);
    assert.equal(manager.hasStreamer('123', 'site-a'), true);
    assert.equal(manager.hasStreamer('123', 'site-c'), false);
    assert.equal(manager.hasStreamer('456', 'site-a'), false);

    // site-a's list no longer has 123: only site-a's capture ends.
    const reconcilerA = new ActiveRecordingReconciler('site-a', manager, () => null);
    await reconcilerA.endRemovedSessions(new Set());
    assert.deepEqual(onA, ['removed from the download list']);
    assert.deepEqual(onB, []);
    assert.equal(manager.hasStreamer('123', 'site-a'), false);
    assert.equal(manager.getRecordingId('123', 'site-b'), 'rb');

    // site-a reports 123 offline for 60 s: site-b's capture (no media yet) is not touched.
    const offline = (observedAt) => ({ observedAt, live: new Map(), terminalTargetIds: new Set(['123']) });
    await reconcilerA.reconcile(offline(0));
    await reconcilerA.reconcile(offline(60_000));
    assert.deepEqual(onB, []);
    assert.equal(await manager.finalizeStreamer('123', 'test', 'site-a'), false);

    // site-b's own rule ends it.
    const reconcilerB = new ActiveRecordingReconciler('site-b', manager, () => null);
    await reconcilerB.reconcile(offline(0));
    await reconcilerB.reconcile(offline(60_000));
    assert.deepEqual(onB, ['offline for 60s without any media']);
});
