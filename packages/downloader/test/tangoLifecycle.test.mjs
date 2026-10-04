import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApiClient } from '../dist/services/tango/api/apiClient.js';
import { StreamDownloader } from '../dist/services/download/streamDownloader.js';
import { AccessIncidentTracker } from '../dist/services/download/accessIncidentTracker.js';
import { StreamSession } from '../dist/services/download/streamSession.js';
import { StreamDiscoveryService } from '../dist/services/tango/discovery/streamDiscoveryService.js';

for (const stage of ['live']) {
    test(`Tango ${stage} 404 finalizes captured media, releases the streamer, and never retries`, async (t) => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'tango-404-'));
        t.after(() => rm(root, { recursive: true, force: true }));
        const name = '2026-09-16 010000 example';
        const active = path.join(root, '.active', name);
        await mkdir(active, { recursive: true });
        await writeFile(path.join(active, '0_stream_10.ts'), 'media');
        await writeFile(path.join(active, 'playlist.m3u8'), '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n0_stream_10.ts\n');
        const api = new ApiClient(async () => ({ st: 'test', tt: 'test', ttu: 'test', tte: '9999999999' }));
        const requests = [];
        t.mock.method(globalThis, 'fetch', async (url) => {
            requests.push(String(url));
            if (stage === 'live' && String(url).endsWith('master.m3u8')) {
                return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=360x640\nlive.m3u8\n');
            }
            return new Response('', { status: 404 });
        });
        api.shouldRetry = async () => { assert.fail('404 must not retry'); };
        let removed = false;
        const handle = {
            masterPlaylistUrl: 'https://example.test/master.m3u8',
            state: { alias: 'example', streamerId: 'account', recordingId: 'stream' },
            update(value) { Object.assign(this.state, value); },
            remove() { removed = true; },
        };
        const result = await new StreamSession('account', 'example', handle, api, 'stream', active).run(handle.masterPlaylistUrl);
        assert.equal(result.aborted, false);
        assert.equal(removed, true);
        assert.equal(requests.length, stage === 'master' ? 1 : 2);
        await assert.rejects(stat(active), { code: 'ENOENT' });
        assert.match(await readFile(path.join(root, '.pending', name, 'playlist.m3u8'), 'utf8'), /#EXT-X-ENDLIST\n$/);
    });
}

test('a master 404 remains a retryable startup failure and does not end the recording', async (t) => {
    const api = new ApiClient(async () => ({ st: 'test', tt: 'test', ttu: 'test', tte: '9999999999' }));
    t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
    const handle = { state: { alias: 'example' }, update() { assert.fail('No live URL expected'); } };
    const downloader = new StreamDownloader(handle, api, new AccessIncidentTracker());
    const result = await downloader.run('https://example.test/master.m3u8', {}, { count: 0 }, {});
    assert.equal(result.exitReason, 'fetch-failed');
    assert.equal(result.aborted, false);
});

test('Tango never refreshes the master during live polling or download retries', async (t) => {
    const api = new ApiClient(async () => ({ st: 'test', tt: 'test', ttu: 'test', tte: '9999999999' }));
    const master = 'https://example.test/master.m3u8';
    const live = 'https://example.test/live.m3u8';
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const requests = [];
    let liveRequests = 0;
    t.mock.method(globalThis, 'fetch', async (url) => {
        requests.push(String(url));
        if (url === master) {
            // Any later master request would 404, but must never happen.
            return requests.length === 1
                ? new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=360x640\nlive.m3u8\n')
                : new Response('', { status: 404 });
        }
        assert.equal(url, live);
        liveRequests++;
        now += 11_000; // Cross the periodic master-quality-check interval.
        return liveRequests < 3 ? new Response('#EXTM3U\n') : new Response('', { status: 404 });
    });
    const handle = {
        state: { alias: 'example', streamerId: 'account', recordingId: 'stream', liveUrl: null },
        update(value) { Object.assign(this.state, value); },
    };
    const playlist = {
        setEdge() {}, timeline: {},
        // Poll once more, then fail a segment to exercise an outer retry.
        async identifyNewSegments() { return liveRequests === 2 ? [{ remoteUrl: 'segment', localName: '0.ts' }] : []; },
        shouldSkipByTimeline() { return false; },
    };
    const makeSession = api.createDownloadSession.bind(api);
    api.createDownloadSession = () => {
        const session = makeSession();
        session.fetchSegment = async () => ({ data: null, retryable: false });
        return session;
    };
    const attempt = () => new StreamDownloader(handle, api, new AccessIncidentTracker())
        .run(master, playlist, { count: 0 }, { materialized: false });
    assert.equal((await attempt()).exitReason, 'segment-failed');
    assert.equal((await attempt()).exitReason, 'playlist-not-found');
    assert.deepEqual(requests, [master, live, live, live]);
});

function discoveryFixture() {
    const targets = [{ accountId: 'account', alias: 'example' }];
    let recordingId = 'old-stream';
    const finalized = [];
    const starts = [];
    const manager = {
        size: 1,
        getRecordingId: () => recordingId,
        has: () => Boolean(recordingId),
        hasStreamer: () => Boolean(recordingId),
        async finalizeStreamer(id) { finalized.push(id); recordingId = null; return true; },
        activeSessions: provider => provider === 'tango' && recordingId ? [{ streamerId: 'account', hasMedia: false }] : [],
        add(url, data) { starts.push(data); return null; },
    };
    const api = { getLiveStreamsByAccountIds: async () => ({
        live: new Map([['account', { accountId: 'account', streamId: 'new-stream', masterPlaylistUrl: 'https://example.test/new.m3u8' }]]),
        rejected: new Map(),
    }) };
    const targetManager = { getTargets: () => [...targets], hasTarget: id => targets.some(t => t.accountId === id), getAlias: () => 'example' };
    const service = new StreamDiscoveryService(api, targetManager, manager);
    // The disk scan is stubbed; removals go through the real shared check.
    const reconciler = service.activeReconciler;
    service.activeReconciler = {
        recoverLocalState: async () => {},
        reconcile: async () => ({ resumePaths: new Map() }),
        endRemovedSessions: listed => reconciler.endRemovedSessions(listed),
    };
    return { service, api, targets, finalized, starts };
}

async function onePoll(t, service) {
    const stop = new Error('test poll complete');
    const lookup = service.apiClient.getLiveStreamsByAccountIds;
    let calls = 0;
    service.apiClient.getLiveStreamsByAccountIds = async (...args) => {
        if (calls++) throw stop;
        return lookup(...args);
    };
    await assert.rejects(service.start(), error => error === stop);
}

test('a newer recording replaces a stuck session even with no folder on disk', async (t) => {
    const fixture = discoveryFixture();
    await onePoll(t, fixture.service);
    assert.deepEqual(fixture.finalized, ['account']);
    assert.equal(fixture.starts[0].recordingId, 'new-stream');
});

test('removing a file target releases its session even when lookup fails', async (t) => {
    const fixture = discoveryFixture();
    fixture.service.previousTargetIds = new Set(['account']);
    fixture.targets.length = 0;
    fixture.api.getLiveStreamsByAccountIds = async () => null;
    await onePoll(t, fixture.service);
    assert.deepEqual(fixture.finalized, ['account']);
    assert.equal(fixture.starts.length, 0);
});

test('a target removed during lookup cannot start a new session', async (t) => {
    const fixture = discoveryFixture();
    const lookup = fixture.api.getLiveStreamsByAccountIds;
    fixture.api.getLiveStreamsByAccountIds = async () => {
        const result = await lookup();
        fixture.targets.splice(0);
        return result;
    };
    await onePoll(t, fixture.service);
    assert.equal(fixture.starts.length, 0);
});
