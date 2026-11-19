// Stitching across copies (CDN edges). The capture e2e against the simulator found
// both cases (docs/showcase-work/sim-capture.md, B1 and B2): copies number their
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
