import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { REJECTED_SEGMENT_MAX_ATTEMPTS, StreamDownloader } from '../dist/services/download/streamDownloader.js';
import { PlaylistManager } from '../dist/services/download/playlistManager.js';
import { DiskSession } from '../dist/services/download/diskSession.js';
import { InitTracker } from '../dist/services/download/initTracker.js';
import { AccessIncidentTracker } from '../dist/services/download/accessIncidentTracker.js';
import { ApiClient } from '../dist/services/tango/api/apiClient.js';
import { PlaylistNotFoundError } from '../dist/services/core/playlistNotFoundError.js';

const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:10\n#EXTINF:1,\na.ts\n#EXTINF:1,\nb.ts\n#EXT-X-ENDLIST\n';

async function fixture(t, fetchSegment) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'segment-retry-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const handle = { state: { alias: 'example' }, update(value) { Object.assign(this.state, value); } };
    const disk = new DiskSession('example', handle, async () => root);
    const manager = new PlaylistManager(disk, 'recording');
    const tracker = new InitTracker(disk);
    const provider = {
        providerName: 'tango', refreshMasterDuringDownload: false,
        parseMasterPlaylist: async () => 'https://example.test/live.m3u8',
        createDownloadSession: () => ({ fetchPlaylist: async () => playlist, fetchSegment }),
        validateSegment: file => ApiClient.prototype.validateSegment.call({}, file),
    };
    const downloader = new StreamDownloader(handle, provider, new AccessIncidentTracker());
    return { root, disk, manager, tracker, downloader, provider,
        run: () => downloader.run('https://example.test/master.m3u8', manager, tracker, disk) };
}

test('later media downloads while a failed segment retries; unknown dimensions stay in playback order', async (t) => {
    const requests = [];
    let firstAttempts = 0;
    let laterDownloaded = false;
    const f = await fixture(t, async (url) => {
        requests.push(url);
        if (url.endsWith('/a.ts')) {
            firstAttempts++;
            if (firstAttempts > 1) assert.equal(laterDownloaded, true);
            if (firstAttempts <= 2) return { data: null, retryable: true, error: 'network-error' };
        } else {
            laterDownloaded = true;
        }
        return { data: Buffer.from(`unprobeable media: ${url}`) };
    });
    const result = await f.run();
    assert.equal(result.exitReason, 'remote-endlist');
    assert.equal(result.segmentCount, 2);
    assert.deepEqual(requests.map(url => path.basename(url)), ['a.ts', 'b.ts', 'a.ts', 'a.ts']);
    const saved = await readFile(path.join(f.root, 'playlist.m3u8'), 'utf8');
    assert.deepEqual(saved.split('\n').filter(line => line.endsWith('.ts')), ['0_recording_10.ts', '1_recording_11.ts']);
    assert.match(await readFile(path.join(f.root, '0_recording_10.ts'), 'utf8'), /a\.ts$/);
    assert.match(await readFile(path.join(f.root, '1_recording_11.ts'), 'utf8'), /b\.ts$/);
});

test('a slow segment does not stop polling: media listed meanwhile is saved, not left to slide out', { timeout: 15000 }, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'segment-retry-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const handle = { state: { alias: 'example' }, update(value) { Object.assign(this.state, value); } };
    const disk = new DiskSession('example', handle, async () => root);
    const manager = new PlaylistManager(disk, 'recording');
    const tracker = new InitTracker(disk);
    const started = Date.now();
    const window = (first, ended = false) => `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:${first}\n`
        + [first, first + 1].map(sequence => `#EXTINF:1,\ns${sequence}.ts\n`).join('') + (ended ? '#EXT-X-ENDLIST\n' : '');
    // A live window that moves on every second, and a first segment that takes 2.5 s.
    const fetchPlaylist = async () => {
        const elapsed = Date.now() - started;
        return elapsed < 900 ? window(10) : elapsed < 1900 ? window(12) : window(14, true);
    };
    const fetchSegment = async url => {
        if (url.endsWith('/s10.ts')) await new Promise(resolve => setTimeout(resolve, 2500));
        return { data: Buffer.from(`unprobeable media: ${url}`) };
    };
    const provider = {
        providerName: 'tango', refreshMasterDuringDownload: false,
        parseMasterPlaylist: async () => 'https://example.test/live.m3u8',
        createDownloadSession: () => ({ fetchPlaylist, fetchSegment }),
        validateSegment: file => ApiClient.prototype.validateSegment.call({}, file),
    };
    const result = await new StreamDownloader(handle, provider, new AccessIncidentTracker())
        .run('https://example.test/master.m3u8', manager, tracker, disk);
    assert.equal(result.exitReason, 'remote-endlist');
    assert.equal(manager.missedSegmentCount, 0);
    const saved = await readFile(path.join(root, 'playlist.m3u8'), 'utf8');
    assert.deepEqual(saved.split('\n').filter(line => line.endsWith('.ts')).map(line => line.split('_').at(-1)),
        ['10.ts', '11.ts', '12.ts', '13.ts', '14.ts', '15.ts']);
});

test('a playlist that ends while a slow segment downloads still saves that segment', { timeout: 15000 }, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'segment-retry-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const handle = { state: { alias: 'example' }, update(value) { Object.assign(this.state, value); } };
    const disk = new DiskSession('example', handle, async () => root);
    const manager = new PlaylistManager(disk, 'recording');
    let calls = 0;
    const fetchPlaylist = async () => {
        if (calls++ === 0) return '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:10\n#EXTINF:1,\ns10.ts\n#EXTINF:1,\ns11.ts\n';
        throw new PlaylistNotFoundError('https://example.test/live.m3u8');
    };
    const fetchSegment = async url => {
        if (url.endsWith('/s11.ts')) await new Promise(resolve => setTimeout(resolve, 1500));
        return { data: Buffer.from(`unprobeable media: ${url}`) };
    };
    const provider = {
        providerName: 'tango', refreshMasterDuringDownload: false,
        parseMasterPlaylist: async () => 'https://example.test/live.m3u8',
        createDownloadSession: () => ({ fetchPlaylist, fetchSegment }),
        validateSegment: file => ApiClient.prototype.validateSegment.call({}, file),
    };
    const result = await new StreamDownloader(handle, provider, new AccessIncidentTracker())
        .run('https://example.test/master.m3u8', manager, new InitTracker(disk), disk);
    assert.equal(result.exitReason, 'playlist-not-found');
    const saved = await readFile(path.join(root, 'playlist.m3u8'), 'utf8');
    assert.deepEqual(saved.split('\n').filter(line => line.endsWith('.ts')).map(line => line.split('_').at(-1)), ['10.ts', '11.ts']);
});

test('HTTP 429 is retried like a network error; other HTTP errors end the attempt', async (t) => {
    const { ScClient } = await import('../dist/services/sc/api/scClient.js');
    let status = 429;
    t.mock.method(globalThis, 'fetch', async () => new Response(null, { status }));
    const sc = new ScClient().createDownloadSession();
    assert.deepEqual(await sc.fetchSegment('https://example.test/a.ts'), { data: null, retryable: true, status: 429 });
    status = 404;
    assert.deepEqual(await sc.fetchSegment('https://example.test/a.ts'), { data: null, retryable: false, status: 404 });
    const tango = new ApiClient(async () => ({})).createDownloadSession();
    status = 429;
    assert.equal((await tango.fetchSegment('https://example.test/a.ts')).retryable, true);
    status = 403;
    assert.equal((await tango.fetchSegment('https://example.test/a.ts')).retryable, false);
});

test('a rate-limited playlist is polled again without variant recovery', { timeout: 15000 }, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'segment-retry-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const handle = { state: { alias: 'example' }, update(value) { Object.assign(this.state, value); } };
    const disk = new DiskSession('example', handle, async () => root);
    const manager = new PlaylistManager(disk, 'recording');
    let polls = 0;
    let recoveries = 0;
    let lastFailure = null;
    const provider = {
        providerName: 'sc', refreshMasterDuringDownload: false,
        parseMasterPlaylist: async () => 'https://example.test/live.m3u8',
        recoverVariant: async () => { recoveries++; return null; },
        createDownloadSession: () => ({
            fetchPlaylist: async () => {
                if (polls++ === 0) { lastFailure = { kind: 'http', status: 429 }; return null; }
                lastFailure = null;
                return playlist;
            },
            getLastPlaylistFailure: () => lastFailure,
            fetchSegment: async url => ({ data: Buffer.from(`unprobeable media: ${url}`) }),
        }),
        validateSegment: file => ApiClient.prototype.validateSegment.call({}, file),
    };
    const result = await new StreamDownloader(handle, provider, new AccessIncidentTracker())
        .run('https://example.test/master.m3u8', manager, new InitTracker(disk), disk);
    assert.equal(result.exitReason, 'remote-endlist');
    assert.equal(recoveries, 0);
    assert.equal(result.segmentCount, 2);
});

test('network retries preserve the 60-second attempt cutoff without marking the segment ignored', async (t) => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const requests = [];
    const f = await fixture(t, async url => {
        requests.push(url);
        now += 30_000;
        return { data: null, retryable: true };
    });
    const result = await f.run();
    assert.equal(result.exitReason, 'stale-timeout');
    assert.equal(result.segmentCount, 0);
    assert.equal(f.disk.materialized, false);
    assert.deepEqual(requests.map(url => path.basename(url)), ['a.ts', 'b.ts']);
    const remaining = await f.manager.identifyNewSegments(playlist, line => line);
    assert.deepEqual(remaining.map(segment => segment.providerSequence), [10, 11]);
});

test('an outstanding segment request does not block the next request', { timeout: 5000 }, async (t) => {
    let releaseFirst;
    const first = new Promise(resolve => { releaseFirst = resolve; });
    const requests = [];
    const f = await fixture(t, async url => {
        requests.push(path.basename(url));
        if (url.endsWith('/a.ts')) return first;
        releaseFirst({ data: Buffer.from('first') });
        return { data: Buffer.from('second') };
    });
    assert.equal((await f.run()).segmentCount, 2);
    assert.deepEqual(requests, ['a.ts', 'b.ts']);
});

test('shutdown stops network retries without advancing to later media', async (t) => {
    let calls = 0;
    const f = await fixture(t, async () => {
        calls++;
        f.downloader.abort();
        return { data: null, retryable: true };
    });
    assert.equal((await f.run()).exitReason, 'aborted');
    assert.equal(calls, 1);
    assert.equal(f.disk.materialized, false);
});

const savedNames = async (root) => (await readFile(path.join(root, 'playlist.m3u8'), 'utf8'))
    .split('\n').filter(line => line.endsWith('.ts'));

test('an empty download is not handled: the next poll fetches it again and keeps playlist order', async (t) => {
    let firstAttempts = 0;
    const f = await fixture(t, async (url) => {
        if (url.endsWith('/a.ts') && ++firstAttempts === 1) return { data: Buffer.alloc(0) };
        return { data: Buffer.from(`media: ${url}`) };
    });
    const result = await f.run();
    assert.equal(result.exitReason, 'remote-endlist');
    assert.equal(result.segmentCount, 2);
    assert.equal(firstAttempts, 2);
    assert.deepEqual(await savedNames(f.root), ['2_recording_10.ts', '3_recording_11.ts']);
    // The empty body was never written; no zero-byte media exists.
    assert.deepEqual((await readdir(f.root)).sort(), ['2_recording_10.ts', '3_recording_11.ts', 'playlist.m3u8']);
});

test('a segment that stays empty is bounded by attempts; later media is still saved', { timeout: 20000 }, async (t) => {
    let emptyAttempts = 0;
    const f = await fixture(t, async (url) => {
        if (url.endsWith('/a.ts')) {
            emptyAttempts++;
            return { data: Buffer.alloc(0) };
        }
        return { data: Buffer.from(`media: ${url}`) };
    });
    const result = await f.run();
    assert.equal(result.exitReason, 'remote-endlist');
    assert.equal(emptyAttempts, REJECTED_SEGMENT_MAX_ATTEMPTS);
    assert.deepEqual(await savedNames(f.root), [`${2 * REJECTED_SEGMENT_MAX_ATTEMPTS - 1}_recording_11.ts`]);
});

test('a written segment the provider cannot read stays on disk and is fetched again', async (t) => {
    let validations = 0;
    const f = await fixture(t, async (url) => ({ data: Buffer.from(`media: ${url}`) }));
    f.provider.validateSegment = async () => ({ valid: ++validations !== 1 });
    const result = await f.run();
    assert.equal(result.exitReason, 'remote-endlist');
    assert.deepEqual(await savedNames(f.root), ['2_recording_10.ts', '3_recording_11.ts']);
    assert.deepEqual((await readdir(f.root)).sort(),
        ['0_recording_10.ts', '2_recording_10.ts', '3_recording_11.ts', 'playlist.m3u8']);
});
