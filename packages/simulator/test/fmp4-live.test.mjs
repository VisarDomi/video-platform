import assert from 'node:assert/strict';
import test from 'node:test';
import { SimClock } from '../dist/clock.js';
import { countZeroSizeSamples, readBoxes } from '../dist/media/fmp4.js';
import { startSimulator } from '../dist/serve.js';
import { decodePlaylist, decodeUri, encodeUri, keyIdOf } from '../dist/sites/obfuscation.js';
import { EPOCH, sharedLibrary, segmentsOf, variantsOf } from './helpers.mjs';

const KEYS = { k1: 'first-secret', k2: 'second-secret' };

function scenario(channelExtra = {}, siteExtra = {}) {
    return {
        name: 'fmp4 test', seed: 'fmp4-seed', epoch: EPOCH,
        sites: { 'fmp4-live': {
            edges: ['a', 'b', 'c'],
            obfuscation: { keys: KEYS, keyId: 'k1' },
            channels: [
                { id: '501', name: 'baseline-rally', schedule: { sessions: [{ start: 0, end: 600 }] }, renames: [{ at: 120, name: 'net-cord' }],
                  edges: [{ id: 'a' }, { id: 'b', lagMs: 300, pdtSkewMs: 15 }, { id: 'c' }], ...channelExtra },
                { id: '502', name: 'second-serve', schedule: { sessions: [{ start: 1000 }] } },
            ],
            ...siteExtra,
        } },
    };
}

async function start(t, channelExtra, siteExtra, at = EPOCH + 30_000) {
    const media = await sharedLibrary();
    const clock = new SimClock({ mode: 'manual', at });
    const sim = await startSimulator({ scenario: scenario(channelExtra, siteExtra), media: media.library, clock, autoPublish: false, memoryTruth: true });
    t.after(() => sim.close());
    return { sim, clock, base: sim.urls['fmp4-live'] };
}

const getJson = async url => (await fetch(url)).json();

test('bulk status, cam detail and username refresh', async (t) => {
    const { clock, base } = await start(t, { faults: [{ type: 'showState', at: 60, until: 90, state: 'group' }] },
        { faults: [{ type: 'apiStatus', at: 400, until: 410, status: 'malformed', api: 'status' }] });
    let body = await getJson(base + '/api/channels/status?ids[]=501&ids[]=502&ids[]=999');
    assert.deepEqual(body.channels.map(m => [m.id, m.status, m.live]), [[501, 'public', true], [502, 'off', false]]);
    const firstChange = body.channels[0].statusSince;
    assert.match(firstChange, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal((await fetch(base + '/api/channels/status?ids=' + Array.from({ length: 101 }, (_, i) => i + 1).join(','))).status, 400);

    const cam = await getJson(base + '/api/channels/501/stream');
    assert.equal(cam.channel.id, 501);
    assert.equal(cam.stream.available, true);
    assert.deepEqual(cam.stream.edges, ['a', 'b', 'c']);
    assert.match(cam.stream.masterUrls.b, /\/edge\/b\/hls\/s501-[0-9a-f]{10}\/master\.m3u8$/);

    clock.set(EPOCH + 70_000);
    body = await getJson(base + '/api/channels/status?ids=501');
    assert.equal(body.channels[0].status, 'group');
    assert.equal(body.channels[0].live, true);
    assert.equal((await getJson(base + '/api/channels/501/stream')).stream.available, false);
    assert.equal((await fetch(cam.stream.masterUrls.a)).status, 403, 'group shows answer 403 on every edge');
    assert.equal((await fetch(cam.stream.masterUrls.c)).status, 403);
    clock.set(EPOCH + 95_000);
    body = await getJson(base + '/api/channels/status?ids=501');
    assert.equal(body.channels[0].status, 'public');
    assert.notEqual(body.channels[0].statusSince, firstChange, 'back to public is a new status change');
    assert.equal((await fetch(cam.stream.masterUrls.a)).status, 200);

    // isOnline is unreliable while live.
    const online = [];
    for (let s = 100; s < 400; s += 30) { clock.set(EPOCH + s * 1000); online.push((await getJson(base + '/api/channels/status?ids=501')).channels[0].online); }
    assert.ok(online.includes(false) && online.includes(true));

    clock.set(EPOCH + 130_000);
    assert.deepEqual(await getJson(base + '/api/channels/by-name/baseline-rally'), { id: 501, name: 'net-cord', renamedTo: 'net-cord' });
    assert.deepEqual(await getJson(base + '/api/channels/by-name/net-cord'), { id: 501, name: 'net-cord' });
    assert.equal((await fetch(base + '/api/channels/by-name/nobody')).status, 404);

    clock.set(EPOCH + 405_000);
    body = await getJson(base + '/api/channels/status?ids=501');
    assert.equal(body.channels, undefined, 'a malformed answer has no channels array');
});

test('edges serve the same stream with independent numbering, skew, and init maps', async (t) => {
    const { base } = await start(t, { obfuscated: false });
    const cam = await getJson(base + '/api/channels/501/stream');
    const playlists = {};
    for (const edge of ['a', 'b']) {
        const master = await (await fetch(cam.stream.masterUrls[edge])).text();
        assert.match(master, /NAME="source"/);
        const variants = variantsOf(master);
        assert.equal(variants.length, 2);
        const text = await (await fetch(new URL(variants[0].uri, cam.stream.masterUrls[edge]))).text();
        assert.match(text, /#EXT-X-MAP:URI="\/edge\/[ab]\/hls\/[^"]+\/fmp4\/init\.mp4"/);
        assert.match(text, /#EXT-X-VERSION:7/);
        playlists[edge] = { text, url: new URL(variants[0].uri, cam.stream.masterUrls[edge]) };
    }
    const a = segmentsOf(playlists.a.text), b = segmentsOf(playlists.b.text);
    assert.notEqual(a.mediaSequence, b.mediaSequence, 'independent numbering');
    const pdtA = new Map(a.segments.map(s => [s.uri.split('/').pop(), Date.parse(s.pdt)]));
    const shared = b.segments.filter(s => pdtA.has(s.uri.split('/').pop()));
    assert.ok(shared.length > 0);
    for (const s of shared) assert.equal(Date.parse(s.pdt) - pdtA.get(s.uri.split('/').pop()), 15, 'edge b stamps 15 ms later');

    const init = Buffer.from(await (await fetch(new URL(/URI="([^"]+)"/.exec(playlists.a.text)[1], playlists.a.url))).arrayBuffer());
    assert.deepEqual(readBoxes(init).map(x => x.type).slice(0, 2), ['ftyp', 'moov']);
    const frag = Buffer.from(await (await fetch(new URL(a.segments.at(-1).uri, playlists.a.url))).arrayBuffer());
    assert.ok(readBoxes(frag).some(x => x.type === 'moof'));
});

test('one edge has an outage while the others stay healthy', async (t) => {
    const { clock, base } = await start(t, { obfuscated: false, faults: [
        { type: 'edgeOutage', edge: 'b', at: 40, until: 50, status: 403 },
        { type: 'edgeOutage', edge: 'b', at: 50, until: 60, status: 404 },
    ] });
    const cam = await getJson(base + '/api/channels/501/stream');
    clock.set(EPOCH + 45_000);
    assert.equal((await fetch(cam.stream.masterUrls.b)).status, 403);
    assert.equal((await fetch(cam.stream.masterUrls.a)).status, 200);
    const media = await (await fetch(new URL(variantsOf(await (await fetch(cam.stream.masterUrls.a)).text())[0].uri, cam.stream.masterUrls.a))).text();
    const seg = segmentsOf(media).segments.at(-1).uri;
    assert.equal((await fetch(base + seg)).status, 200);
    assert.equal((await fetch(base + seg.replace('/edge/a/', '/edge/b/'))).status, 403, 'segments on the failing edge fail too');
    clock.set(EPOCH + 55_000);
    assert.equal((await fetch(cam.stream.masterUrls.b)).status, 404);
    clock.set(EPOCH + 61_000);
    assert.equal((await fetch(cam.stream.masterUrls.b)).status, 200);
});

test('obfuscated playlists round-trip with the configured key, and fail without it', async (t) => {
    const { clock, base } = await start(t, { obfuscated: true }, { faults: [{ type: 'obfuscationKey', at: 100, keyId: 'k2' }] });
    const cam = await getJson(base + '/api/channels/501/stream');
    const master = await (await fetch(cam.stream.masterUrls.a)).text();
    assert.equal(keyIdOf(master), 'k1');
    const url = new URL(variantsOf(master)[0].uri, cam.stream.masterUrls.a);
    const text = await (await fetch(url)).text();
    assert.equal(keyIdOf(text), 'k1');
    assert.match(text, /#EXT-X-OBF-URI:[0-9a-f]{8}\./);
    const placeholders = segmentsOf(text).segments;
    assert.ok(placeholders.every(s => s.uri.endsWith('/obfuscated.m4s')));
    assert.equal((await fetch(new URL(placeholders[0].uri, url))).status, 404);

    const decoded = decodePlaylist(text, { k1: KEYS.k1 });
    assert.equal(decoded.ok, true);
    assert.equal(decoded.decoded, placeholders.length);
    assert.doesNotMatch(decoded.playlist, /OBF/);
    const real = segmentsOf(decoded.playlist).segments;
    assert.ok(real.every(s => /\/\d+\.m4s$/.test(s.uri)));
    assert.equal((await fetch(new URL(real.at(-1).uri, url))).status, 200);

    assert.deepEqual(decodePlaylist(text, { k2: KEYS.k2 }), { ok: false, reason: 'unknown-key', keyId: 'k1' });
    assert.deepEqual(decodePlaylist(text, { k1: 'wrong' }), { ok: false, reason: 'undecodable', keyId: 'k1' });

    clock.set(EPOCH + 101_000);
    const rotated = await (await fetch(url)).text();
    assert.equal(keyIdOf(rotated), 'k2');
    assert.equal(decodePlaylist(rotated, KEYS).ok, true);
});

test('the URI encoding is a reversible, key-checked token', () => {
    const uri = '/edge/a/hls/s501-0123456789/fmp4/1234.m4s';
    const token = encodeUri(uri, 'secret');
    assert.notEqual(token, uri);
    assert.ok(!token.includes('1234'));
    assert.equal(decodeUri(token, 'secret'), uri);
    assert.equal(decodeUri(token, 'other'), null);
    assert.equal(decodeUri('garbage', 'secret'), null);
    assert.equal(encodeUri(uri, 'secret'), token, 'deterministic');
});

test('damage windows serve zero-size sample entries; codec changes switch the init map', async (t) => {
    const { base } = await start(t, { obfuscated: false, startPosition: 0, faults: [
        { type: 'damage', at: 20, until: 26, kind: 'zero-size-sample' },
        { type: 'codecChange', at: 26, until: 1000 },
    ] }, {}, EPOCH + 30_000);
    const cam = await getJson(base + '/api/channels/501/stream');
    const url = new URL(variantsOf(await (await fetch(cam.stream.masterUrls.a)).text())[0].uri, cam.stream.masterUrls.a);
    const text = await (await fetch(url)).text();
    const maps = [...text.matchAll(/#EXT-X-MAP:URI="([^"]+)"/g)].map(m => m[1].split('/').at(-2));
    assert.deepEqual(maps, ['fmp4', 'fmp4-alt'], 'a new init map at the change');
    const lines = text.split('\n');
    const entries = [];
    let pdt = null;
    for (const line of lines) {
        if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pdt = Date.parse(line.slice(25));
        else if (line && !line.startsWith('#')) entries.push({ uri: line, start: (pdt - EPOCH) / 1000 });
    }
    for (const e of entries) {
        const data = Buffer.from(await (await fetch(new URL(e.uri, url))).arrayBuffer());
        const zero = countZeroSizeSamples(data);
        assert.equal(zero, e.start >= 20 && e.start < 26 ? 1 : 0, `segment starting at ${e.start}s`);
    }
});
