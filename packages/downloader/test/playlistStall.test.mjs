import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { StreamDownloader } from '../dist/services/download/streamDownloader.js';
import { PlaylistManager } from '../dist/services/download/playlistManager.js';
import { DiskSession } from '../dist/services/download/diskSession.js';
import { InitTracker } from '../dist/services/download/initTracker.js';
import { AccessIncidentTracker } from '../dist/services/download/accessIncidentTracker.js';
import { ApiClient } from '../dist/services/tango/api/apiClient.js';

async function fixture(t, provider) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'playlist-stall-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const handle = { state: { alias: 'example' }, update(value) { Object.assign(this.state, value); } };
    const disk = new DiskSession('example', handle, async () => root);
    const manager = new PlaylistManager(disk, 'recording');
    const downloader = new StreamDownloader(handle, {
        providerName: 'tango',
        playlistRetryMs: 100,
        parseMasterPlaylist: async () => 'https://example.test/live.m3u8',
        recoverVariant: async () => null,
        validateSegment: file => ApiClient.prototype.validateSegment.call({}, file),
        ...provider,
    }, new AccessIncidentTracker());
    return { manager, run: () => downloader.run('https://example.test/master.m3u8', manager, new InitTracker(disk), disk) };
}

const fetchSegment = async url => ({ data: Buffer.from(`unprobeable media: ${url}`) });

// A live window of two one-second segments that moves on every second.
function movingWindow(endAfterMs) {
    const started = performance.now();
    return () => {
        const elapsed = performance.now() - started;
        const first = 10 + Math.floor(elapsed / 1000);
        return `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:${first}\n`
            + [first, first + 1].map(sequence => `#EXTINF:1,\ns${sequence}.ts\n`).join('')
            + (elapsed > endAfterMs ? '#EXT-X-ENDLIST\n' : '');
    };
}

test('a playlist request that hangs is hedged: a second request answers and the hung one is aborted', { timeout: 20000 }, async (t) => {
    const window = movingWindow(4000);
    let calls = 0;
    const aborted = [];
    const fetchPlaylist = (url, signal) => {
        const call = ++calls;
        // The third request stalls like a dead connection: it answers only
        // when aborted, or after eight seconds.
        if (call !== 3) return Promise.resolve(window());
        return new Promise(resolve => {
            const timer = setTimeout(() => resolve(null), 8000);
            signal?.addEventListener('abort', () => { clearTimeout(timer); aborted.push(call); resolve(null); });
        });
    };
    const f = await fixture(t, { refreshMasterDuringDownload: false, createDownloadSession: () => ({ fetchPlaylist, fetchSegment }) });
    const result = await f.run();
    assert.equal(result.exitReason, 'remote-endlist');
    assert.deepEqual(aborted, [3]);
    assert.equal(f.manager.missedSegmentCount, 0);
});

test('a slow master check does not hold up playlist polling', { timeout: 20000 }, async (t) => {
    // The quality check runs every QUALITY_CHECK_INTERVAL_MS by Date.now();
    // the first poll moves that clock past it.
    const realNow = Date.now;
    let offset = 0;
    t.mock.method(Date, 'now', () => realNow.call(Date) + offset);
    const window = movingWindow(5000);
    let polls = 0;
    const fetchPlaylist = async () => {
        if (polls++ === 0) offset = 11_000;
        return window();
    };
    // The first master parse picks the live URL before polling starts.
    let masterChecks = 0;
    const parseMasterPlaylist = async () => {
        if (polls > 0) {
            masterChecks++;
            await new Promise(resolve => setTimeout(resolve, 3500));
        }
        return 'https://example.test/live.m3u8';
    };
    const f = await fixture(t, { parseMasterPlaylist, createDownloadSession: () => ({ fetchPlaylist, fetchSegment }) });
    const result = await f.run();
    assert.equal(result.exitReason, 'remote-endlist');
    assert.equal(masterChecks, 1);
    assert.equal(f.manager.missedSegmentCount, 0);
});

test('an aborted playlist request records no failure', async (t) => {
    const { ScClient } = await import('../dist/services/sc/api/scClient.js');
    t.mock.method(globalThis, 'fetch', (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
    }));
    const session = new ScClient().createDownloadSession();
    const controller = new AbortController();
    const pending = session.fetchPlaylist('https://example.test/live.m3u8', controller.signal);
    controller.abort();
    assert.equal(await pending, null);
    assert.equal(session.getLastPlaylistFailure(), null);
});
