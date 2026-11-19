// Each fault type, as a client sees it over HTTP (ts-live, ladder-live). The
// engine tests cover the window arithmetic; these cover what is served.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SimClock } from '../dist/clock.js';
import { startSimulator } from '../dist/serve.js';
import { firstVideoPts, videoPids } from '../dist/media/ts.js';
import { EPOCH, sharedLibrary, segmentsOf } from './helpers.mjs';

async function start(t, faults, at) {
    const media = await sharedLibrary();
    const clock = new SimClock({ mode: 'manual', at });
    const sim = await startSimulator({
        scenario: { name: 'faults', seed: 'fault-seed', epoch: EPOCH, sites: { 'ladder-live': { channels: [
            { id: '42', name: 'faulty', startPosition: 0, edges: [{ id: 'a', firstSequence: 0 }], schedule: { always: true }, faults },
        ] } } },
        media: media.library, clock, autoPublish: false, memoryTruth: true,
    });
    t.after(() => sim.close());
    const base = sim.urls['ladder-live'];
    // Skip the handshake: the playlist path is stable for a session.
    const key = sim.sim.engine.channel('ladder-live', '42').sessionAt(at).key;
    const media0 = `${base}/hls/stream/42/${key}/50/playlist.m3u8`;
    return { sim, clock, base, master: `${base}/hls/stream/42/${key}/master.m3u8`, media: media0 };
}

const fetchPlaylist = async url => { const res = await fetch(url); return { status: res.status, text: await res.text() }; };

test('playlist status windows hit master, media or both', async (t) => {
    const { clock, master, media } = await start(t, [
        { type: 'playlistStatus', at: 10, until: 20, status: 503, target: 'master' },
        { type: 'playlistStatus', at: 20, until: 30, status: 429 },
        { type: 'playlistStatus', at: 30, until: 40, status: 401, target: 'any' },
        { type: 'playlistStatus', at: 40, until: 50, status: 404 },
        { type: 'playlistStatus', at: 50, until: 60, status: 500, target: 'any' },
    ], EPOCH + 15_000);
    assert.equal((await fetch(master)).status, 503);
    assert.equal((await fetch(media)).status, 200);
    clock.set(EPOCH + 25_000);
    assert.equal((await fetch(master)).status, 200);
    assert.equal((await fetch(media)).status, 429);
    clock.set(EPOCH + 35_000);
    assert.equal((await fetch(master)).status, 401);
    assert.equal((await fetch(media)).status, 401);
    clock.set(EPOCH + 45_000);
    assert.equal((await fetch(media)).status, 404);
    clock.set(EPOCH + 55_000);
    assert.equal((await fetch(media)).status, 500);
    clock.set(EPOCH + 61_000);
    assert.equal((await fetch(media)).status, 200);
});

test('segment errors, connection resets and stale playlists', async (t) => {
    const { clock, base, media } = await start(t, [
        { type: 'segmentStatus', at: 20, until: 30, status: 429 },
        { type: 'edgeOutage', at: 30, until: 35, edge: 'a', status: 'reset' },
        { type: 'stalePlaylist', at: 40, until: 50 },
    ], EPOCH + 19_000);
    const seg = segmentsOf((await fetchPlaylist(media)).text).segments.at(-1).uri;
    assert.equal((await fetch(base + seg)).status, 200);
    clock.set(EPOCH + 21_000);
    assert.equal((await fetch(base + seg)).status, 429);
    clock.set(EPOCH + 31_000);
    await assert.rejects(fetch(base + seg), 'the connection is cut');
    clock.set(EPOCH + 41_000);
    const first = (await fetchPlaylist(media)).text;
    clock.set(EPOCH + 49_000);
    assert.equal((await fetchPlaylist(media)).text, first, 'a stale cache serves the same playlist');
    clock.set(EPOCH + 51_000);
    assert.notEqual((await fetchPlaylist(media)).text, first);
});

test('a provider skip leaves a hole in the numbering; damaged segments are served as scripted', async (t) => {
    const { clock, base, media, sim } = await start(t, [
        { type: 'skip', at: 20, count: 2 },
        { type: 'damage', at: 30, until: 34, kind: 'single-frame' },
        { type: 'damage', at: 34, until: 36, kind: 'zero-byte' },
        { type: 'damage', at: 36, until: 38, kind: 'truncated' },
    ], EPOCH + 19_500);
    // Poll every second through the skip: the window stalls, then restarts
    // small after a hole of exactly two sequence numbers.
    const seen = new Set();
    let stalledPolls = 0, previous = null;
    for (let ms = 19_500; ms <= 32_500; ms += 1000) {
        clock.set(EPOCH + ms);
        const text = (await fetchPlaylist(media)).text;
        if (text === previous) stalledPolls++;
        previous = text;
        for (const seg of segmentsOf(text).segments) seen.add(seg.seq);
    }
    const seqs = [...seen].sort((a, b) => a - b);
    const missing = [];
    for (let n = seqs[0]; n <= seqs.at(-1); n++) if (!seen.has(n)) missing.push(n);
    assert.equal(missing.length, 2, `missing ${missing}`);
    assert.equal(missing[1], missing[0] + 1);
    assert.ok(stalledPolls >= 3, 'the playlist stood still during the stall');
    // Fetch each segment by position once all are published, and compare
    // with the damage scripted for the instant it starts.
    clock.set(EPOCH + 45_000);
    const model = sim.sim.engine.channel('ladder-live', '42');
    const session = model.sessionAt(EPOCH + 45_000);
    const base0 = media.replace('/50/playlist.m3u8', '/5/');
    const kinds = new Map();
    for (let k = 14; k <= 20; k++) {
        const start = (model.segmentStartMs(session, k) - EPOCH) / 1000;
        const kind = start >= 30 && start < 34 ? 'single-frame' : start >= 34 && start < 36 ? 'zero-byte' : start >= 36 && start < 38 ? 'truncated' : 'clean';
        const res = await fetch(`${base0}${k}.ts`);
        assert.equal(res.status, 200);
        const body = Buffer.from(await res.arrayBuffer());
        kinds.set(kind, [...(kinds.get(kind) ?? []), body]);
    }
    assert.deepEqual([...kinds.keys()].sort(), ['clean', 'single-frame', 'truncated', 'zero-byte']);
    const cleanSize = Math.min(...kinds.get('clean').map(b => b.length));
    for (const b of kinds.get('single-frame')) {
        assert.ok(b.length > 0 && b.length < cleanSize / 2, 'cut to its first frame');
        assert.ok(videoPids(b).size === 1 && firstVideoPts(b) !== null, 'still a valid transport stream');
    }
    for (const b of kinds.get('zero-byte')) assert.equal(b.length, 0, 'zero bytes with a 200');
    for (const b of kinds.get('truncated')) assert.ok(b.length > 0 && b.length < cleanSize);
    assert.equal(base.startsWith('http'), true);
});

test('a codec change switches the rendition behind the same playlist', async (t) => {
    // In the first pass of the source no timestamps move, so served bytes
    // equal the cached files and can be matched by hash.
    const { base, media, sim } = await start(t, [{ type: 'codecChange', at: 0, until: 3 }], EPOCH + 7_000);
    const model = sim.sim.engine.channel('ladder-live', '42');
    const [top, next] = model.renditions;
    const segs = segmentsOf((await fetchPlaylist(media)).text).segments;
    assert.equal(segs.length, 3);
    const hashes = [];
    for (const s of segs) {
        const res = await fetch(base + s.uri);
        assert.equal(res.status, 200);
        hashes.push(sim.memory.records.filter(r => r.type === 'response' && r.kind === 'segment').at(-1).sha256);
    }
    assert.deepEqual(hashes, [next.segments[0].sha256, next.segments[1].sha256, top.segments[2].sha256]);
});
