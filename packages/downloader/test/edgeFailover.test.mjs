// Stitching across copies (CDN edges). The capture e2e against the simulator shows
// both cases: copies number their
// segments independently and stamp date-times with their own clocks, so after a
// failover the segments the new copy re-lists are recognised by date-time only.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DiskSession } from '../dist/services/download/diskSession.js';
import * as playlistModule from '../dist/services/download/playlistManager.js';

const { PlaylistManager } = playlistModule;
const T0 = Date.parse('2026-01-01T12:00:00.000Z');

// A live window of 2-second segments k = firstK.. on one copy, numbered from
// firstSequence, every date-time shifted by skewMs.
function window({ firstSequence, firstK, count, skewMs = 0, end = false }) {
    return ['#EXTM3U', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${firstSequence}`,
        ...Array.from({ length: count }, (_, i) => [
            `#EXT-X-PROGRAM-DATE-TIME:${new Date(T0 + (firstK + i) * 2000 + skewMs).toISOString()}`, '#EXTINF:2.000,', `k${firstK + i}.ts`,
        ]).flat(),
        ...(end ? ['#EXT-X-ENDLIST'] : [])].join('\n') + '\n';
}

const kOf = (segment) => Number(/k(\d+)/.exec(segment.remoteUrl ?? segment)[1]);

async function manager(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'edge-failover-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const disk = new DiskSession('edge', { update() {} }, async () => root);
    const playlist = new PlaylistManager(disk, 'rec');
    const save = async (segments) => {
        await disk.materialize();
        for (const segment of segments) {
            await playlist.appendSegmentToPlaylist(segment);
            playlist.recordDownloadedPDT(segment.programDateTime);
        }
    };
    return { playlist, save, root };
}

// k0..k5 saved from edge a (numbered 1000 + k), then the recoverVariant failover to
// edge b: setEdge + onEdgeSwitch, b's window lists k3..k8 (numbered 200 + k).
async function afterFailover(t, skewMs) {
    const { playlist, save } = await manager(t);
    playlist.setEdge('a');
    await save(await playlist.identifyNewSegments(window({ firstSequence: 1000, firstK: 0, count: 6 }), (line) => `http://a/${line}`));
    playlist.setEdge('b');
    playlist.onEdgeSwitch('a', 'b');
    const listed = await playlist.identifyNewSegments(window({ firstSequence: 203, firstK: 3, count: 6, skewMs }), (line) => `http://b/${line}`);
    return listed.filter((segment) => !playlist.shouldSkipByTimeline(segment)).map(kOf);
}

test('B1: a copy that stamps its date-times a little later re-lists nothing as new', async (t) => {
    for (const skewMs of [1, 20, 999, 1000]) {
        assert.deepEqual(await afterFailover(t, skewMs), [6, 7, 8], `b stamps ${skewMs} ms late`);
    }
});

test('B1: copies with equal or earlier date-times still stitch exactly', async (t) => {
    for (const skewMs of [0, -20, -999]) {
        assert.deepEqual(await afterFailover(t, skewMs), [6, 7, 8], `b stamps ${-skewMs} ms early`);
    }
});

test('B1: the tolerance is half the EXTINF; a later date-time is new media', async (t) => {
    assert.equal(playlistModule.EDGE_DEDUP_TOLERANCE_EXTINF_FRACTION, 0.5);
    // 1001 ms after the last saved date-time is more than half a 2-second segment: the
    // next segment of a copy running that far behind, not a re-listing.
    assert.deepEqual(await afterFailover(t, 1001), [5, 6, 7, 8]);
    // Within tolerance the dedup stays on until the first new segment; that one
    // switches it off, so the copy's later segments are saved as they come.
    const { playlist, save } = await manager(t);
    playlist.setEdge('a');
    await save(await playlist.identifyNewSegments(window({ firstSequence: 1000, firstK: 0, count: 6 }), (line) => `http://a/${line}`));
    playlist.setEdge('b');
    playlist.onEdgeSwitch('a', 'b');
    const reListed = await playlist.identifyNewSegments(window({ firstSequence: 205, firstK: 5, count: 1, skewMs: 20 }), (line) => `http://b/${line}`);
    assert.deepEqual(reListed.filter((segment) => !playlist.shouldSkipByTimeline(segment)).map(kOf), [], 'k5 again, 20 ms late');
    const next = await playlist.identifyNewSegments(window({ firstSequence: 205, firstK: 5, count: 3, skewMs: 20 }), (line) => `http://b/${line}`);
    const kept = next.filter((segment) => !playlist.shouldSkipByTimeline(segment));
    assert.deepEqual(kept.map(kOf), [6, 7]);
    await save(kept);
    const later = await playlist.identifyNewSegments(window({ firstSequence: 206, firstK: 6, count: 3, skewMs: 20 }), (line) => `http://b/${line}`);
    assert.deepEqual(later.filter((segment) => !playlist.shouldSkipByTimeline(segment)).map(kOf), [8]);
});

// ---- B2: a new attempt that starts on another copy ----------------------------------

const { StreamDownloader } = await import('../dist/services/download/streamDownloader.js');
const { InitTracker } = await import('../dist/services/download/initTracker.js');
const { AccessIncidentTracker } = await import('../dist/services/download/accessIncidentTracker.js');

// Two copies of one stream, as StreamSession meets them: the first attempt records
// k0..k5 from edge a (numbered 1000 + k) and stops when k6 fails there; the retry's
// master names edge b, whose window lists k3..k8 (numbered bFirstSequence + k) and ends.
async function retryOnAnotherCopy(t, { bFirstSequence, skewMs = 0 }) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'edge-retry-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const handle = { state: { alias: 'edge', streamerId: '1', recordingId: 'rec' }, update(value) { Object.assign(this.state, value); } };
    const disk = new DiskSession('edge', handle, async () => root);
    const playlist = new PlaylistManager(disk, 'rec');
    const initTracker = new InitTracker(disk);
    const edgeOf = (url) => /\/edge\/(\w+)\//.exec(url)?.[1] ?? null;
    const provider = {
        providerName: 'edge-test',
        playlistRetryMs: 100,
        parseMasterPlaylist: async (master) => master.replace('master.m3u8', 'live.m3u8'),
        recoverVariant: async () => null,
        edgeOf,
        validateSegment: async () => ({ valid: true }),
        createDownloadSession: () => ({
            fetchPlaylist: async (url) => edgeOf(url) === 'a'
                ? window({ firstSequence: 1000, firstK: 0, count: 7 })
                : window({ firstSequence: bFirstSequence + 3, firstK: 3, count: 6, skewMs, end: true }),
            fetchSegment: async (url) => (edgeOf(url) === 'a' && kOf(url) === 6
                ? { data: null, retryable: false, status: 503 }
                : { data: Buffer.from(`k${kOf(url)} from ${edgeOf(url)}`) }),
        }),
    };
    const attempt = (edge) => new StreamDownloader(handle, provider, new AccessIncidentTracker())
        .run(`https://cdn.test/edge/${edge}/stream/master.m3u8`, playlist, initTracker, disk);
    const first = await attempt('a');
    const second = await attempt('b');
    const names = (await readFile(path.join(disk.dirPath, 'playlist.m3u8'), 'utf8')).split('\n').filter((line) => line && !line.startsWith('#'));
    const saved = await Promise.all(names.map(async (name) => (await readFile(path.join(disk.dirPath, name), 'utf8')).replace(' from ', '@')));
    return { exits: [first.exitReason, second.exitReason], saved, missed: playlist.missedSegmentCount };
}

const once = ['k0@a', 'k1@a', 'k2@a', 'k3@a', 'k4@a', 'k5@a', 'k6@b', 'k7@b', 'k8@b'];

test('B2: a retry on a copy numbered lower saves only what is new', async (t) => {
    const result = await retryOnAnotherCopy(t, { bFirstSequence: 200 });
    assert.deepEqual(result.exits, ['segment-failed', 'remote-endlist']);
    assert.deepEqual(result.saved, once);
    assert.equal(result.missed, 0);
});

test('B2: a retry on a copy numbered higher saves only what is new and counts no gap', async (t) => {
    const result = await retryOnAnotherCopy(t, { bFirstSequence: 5000 });
    assert.deepEqual(result.saved, once);
    assert.equal(result.missed, 0, 'another numbering is not a gap');
});

test('B2: a retry on a copy stamping later date-times is stitched too (with B1)', async (t) => {
    assert.deepEqual((await retryOnAnotherCopy(t, { bFirstSequence: 200, skewMs: 20 })).saved, once);
});

test('a retry on the same copy dedups by sequence, as before', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'edge-same-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const handle = { state: { alias: 'edge', streamerId: '1', recordingId: 'rec' }, update(value) { Object.assign(this.state, value); } };
    const disk = new DiskSession('edge', handle, async () => root);
    const playlist = new PlaylistManager(disk, 'rec');
    const initTracker = new InitTracker(disk);
    let attempts = 0;
    const provider = {
        providerName: 'edge-test', playlistRetryMs: 100, recoverVariant: async () => null,
        parseMasterPlaylist: async () => 'https://cdn.test/edge/a/stream/live.m3u8',
        edgeOf: () => 'a',
        validateSegment: async () => ({ valid: true }),
        createDownloadSession: () => ({
            fetchPlaylist: async () => (attempts === 1
                ? window({ firstSequence: 1000, firstK: 0, count: 7 })
                : window({ firstSequence: 1003, firstK: 3, count: 6, end: true })),
            fetchSegment: async (url) => (attempts === 1 && kOf(url) === 6 ? { data: null, retryable: false, status: 503 } : { data: Buffer.from(`k${kOf(url)}`) }),
        }),
    };
    const attempt = () => { attempts++; return new StreamDownloader(handle, provider, new AccessIncidentTracker()).run('https://cdn.test/edge/a/stream/master.m3u8', playlist, initTracker, disk); };
    await attempt();
    await attempt();
    const names = (await readFile(path.join(disk.dirPath, 'playlist.m3u8'), 'utf8')).split('\n').filter((line) => line && !line.startsWith('#'));
    assert.deepEqual(names.map((name) => Number(name.split('_').at(-1).split('.')[0])), [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008]);
    assert.equal(playlist.missedSegmentCount, 0);
});

// The next real segment starts one EXTINF of the last SAVED segment later. After a
// short segment (a cut at a restart or discontinuity), that is closer than half the
// next segment's EXTINF: the tolerance uses the shorter one, so the next segment is
// never mistaken for a re-listing and dropped.
test('B1: after a short saved segment, the next segment from another copy is new media', async (t) => {
    const { playlist } = await manager(t);
    playlist.setEdge('a');
    const seg = (k, startMs, extinf) => ['#EXTM3U', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${1000 + k}`,
        `#EXT-X-PROGRAM-DATE-TIME:${new Date(T0 + startMs).toISOString()}`, `#EXTINF:${extinf},`, `k${k}.ts`].join('\n') + '\n';
    const first = await playlist.identifyNewSegments(seg(0, 0, '0.500'), (line) => `http://a/${line}`);
    assert.deepEqual(first.map(kOf), [0]);
    playlist.recordDownloadedPDT(first[0].programDateTime, playlistModule.extinfSeconds(first[0].metadata));
    playlist.setEdge('b');
    playlist.onEdgeSwitch('a', 'b');
    // k1 starts 500 ms after k0 (k0 lasted 0.5 s) and lasts 2 s; b stamps 20 ms late.
    const listed = await playlist.identifyNewSegments(seg(1, 520, '2.000'), (line) => `http://b/${line}`);
    assert.deepEqual(listed.filter((segment) => !playlist.shouldSkipByTimeline(segment)).map(kOf), [1],
        'k1 is 520 ms after a 0.5 s segment: more than half the shorter EXTINF (250 ms), so it is new');
    // The same short segment re-listed 20 ms late is still recognised.
    const again = await manager(t);
    again.playlist.setEdge('a');
    const k0 = await again.playlist.identifyNewSegments(seg(0, 0, '0.500'), (line) => `http://a/${line}`);
    again.playlist.recordDownloadedPDT(k0[0].programDateTime, playlistModule.extinfSeconds(k0[0].metadata));
    again.playlist.setEdge('b');
    again.playlist.onEdgeSwitch('a', 'b');
    const reListed = await again.playlist.identifyNewSegments(seg(0, 20, '0.500'), (line) => `http://b/${line}`);
    assert.deepEqual(reListed.filter((segment) => !again.playlist.shouldSkipByTimeline(segment)).map(kOf), []);
});
