import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { SimClock } from '../dist/clock.js';
import { startSimulator } from '../dist/serve.js';
import { validateScenario, ScenarioError } from '../dist/scenario/schema.js';
import { EPOCH, sharedLibrary } from './helpers.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');

async function start(t, siteExtra = {}, at = EPOCH + 10_000) {
    const media = await sharedLibrary();
    const source = media.library.ids()[0];
    const rung = readdirSync(path.join(media.cache, source)).find(d => d.startsWith('work-rung-'));
    const files = [
        { id: 'f1', name: 'Final set.mp4', album: 'al1', at: 0 },
        { id: 'f2', name: 'Tie break.mp4', album: 'al1', at: 1, ...(rung ? { from: rung.slice(5) } : {}) },
        { id: 'f3', name: 'Match point.mp4', album: 'al1', at: 2 },
        { id: 'later', name: 'Later.mp4', album: 'al1', at: 60 },
    ];
    const clock = new SimClock({ mode: 'manual', at });
    const sim = await startSimulator({
        scenario: { name: 'files', seed: 'files-seed', epoch: EPOCH, sites: { 'file-host': { files, albums: [{ id: 'al1', title: 'Day one' }], albumPageSize: 2, ...siteExtra } } },
        media: media.library, clock, autoPublish: false, memoryTruth: true,
    });
    t.after(() => sim.close());
    const site = sim.sim.sites.get('file-host');
    await site.whenHashed();
    const mezzanine = readFileSync(path.join(media.cache, source, 'work-mezzanine', 'mezzanine.mp4'));
    return { sim, clock, site, base: sim.urls['file-host'], cdn: sim.urls['file-host-cdn'], mezzanine, events: () => sim.memory.records.filter(r => r.type === 'event') };
}

const link = async (base, id, headers = {}) => (await fetch(base + '/api/link', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ id }),
})).json();

/** GET with node:http: counts bytes even when the connection dies mid-body. */
function rawGet(url, headers = {}) {
    return new Promise(resolve => {
        const started = Date.now();
        const req = http.get(url, { headers }, res => {
            let bytes = 0;
            res.on('data', c => { bytes += c.length; });
            res.on('end', () => resolve({ status: res.statusCode, bytes, complete: true, ms: Date.now() - started, headers: res.headers }));
            res.on('error', () => resolve({ status: res.statusCode, bytes, complete: false, ms: Date.now() - started, headers: res.headers }));
            res.on('aborted', () => resolve({ status: res.statusCode, bytes, complete: false, ms: Date.now() - started, headers: res.headers }));
        });
        req.on('error', () => resolve({ status: null, bytes: 0, complete: false, ms: Date.now() - started }));
    });
}

test('file pages, album listings with pages, and files that appear later', async (t) => {
    const { clock, base } = await start(t);
    let res = await fetch(base + '/a/al1');
    assert.equal(res.status, 200);
    let page = await res.text();
    assert.equal([...page.matchAll(/class="item" data-file-id="([^"]+)"/g)].map(m => m[1]).join(','), 'f1,f2');
    assert.match(page, /data-count="3"/, 'the file that appears at 60 s is not listed yet');
    assert.match(page, /rel="next" href="\/a\/al1\?page=2"/);
    page = await (await fetch(base + '/a/al1?page=2')).text();
    assert.equal([...page.matchAll(/data-file-id="([^"]+)"/g)].map(m => m[1]).join(','), 'f3');
    assert.match(page, /rel="prev"/);
    assert.equal((await fetch(base + '/a/al1?page=3')).status, 404, 'past the last page');
    assert.equal((await fetch(base + '/a/nope')).status, 404);

    page = await (await fetch(base + '/f/f1')).text();
    assert.match(page, /<a id="download" class="download-button" href="\/download\/f1"/);
    assert.match(page, /window\.fileContext = \{"id":"f1","name":"Final set.mp4","size":\d+/);
    assert.match(page, /og:image/);
    assert.equal((await fetch(base + '/thumb/f1.svg')).headers.get('content-type'), 'image/svg+xml');
    assert.equal((await fetch(base + '/f/later')).status, 404);
    clock.set(EPOCH + 61_000);
    assert.equal((await fetch(base + '/f/later')).status, 200);
    const api = await (await fetch(base + '/api/file/later')).json();
    assert.equal(api.name, 'Later.mp4');
    assert.equal(api.page, base + '/f/later');
});

test('a signed link on the download host serves the file, ranges included; it expires', async (t) => {
    const { clock, base, cdn, mezzanine, events } = await start(t, { signatureTtlS: 30 });
    const l = await link(base, 'f1');
    assert.ok(l.url.startsWith(cdn + '/dl/f1/'), 'another port than the site');
    assert.notEqual(new URL(cdn).port, new URL(base).port);
    assert.equal(l.expires, Math.floor((EPOCH + 10_000) / 1000) + 30);

    let res = await fetch(l.url);
    assert.equal(res.status, 200);
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(mezzanine), 'the prepared original, byte for byte');
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
    assert.match(res.headers.get('content-disposition'), /filename="Final set.mp4"/);
    const etag = res.headers.get('etag');
    const fileEvent = events().find(e => e.event === 'file' && e.file === 'f1');
    assert.equal(fileEvent.sha256, sha(mezzanine));
    assert.equal(fileEvent.bytes, mezzanine.length);

    res = await fetch(l.url, { headers: { range: 'bytes=100-299' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), `bytes 100-299/${mezzanine.length}`);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(mezzanine.subarray(100, 300)));
    res = await fetch(l.url, { headers: { range: 'bytes=1000-', 'if-range': etag } });
    assert.equal(res.status, 206);
    assert.equal(Number(res.headers.get('content-length')), mezzanine.length - 1000);
    res = await fetch(l.url, { headers: { range: 'bytes=1000-', 'if-range': '"other"' } });
    assert.equal(res.status, 200, 'a different validator gets the whole file');
    await res.arrayBuffer();
    res = await fetch(l.url, { headers: { range: `bytes=${mezzanine.length}-` } });
    assert.equal(res.status, 416);
    assert.equal(res.headers.get('content-range'), `bytes */${mezzanine.length}`);
    res = await fetch(l.url, { method: 'HEAD' });
    assert.equal(Number(res.headers.get('content-length')), mezzanine.length);

    const forged = new URL(l.url);
    forged.searchParams.set('exp', String(l.expires + 3600));
    res = await fetch(forged);
    assert.equal(res.status, 403);
    assert.equal(await res.text(), 'Invalid signature');
    clock.set(EPOCH + 40_000);
    res = await fetch(l.url);
    assert.equal(res.status, 403);
    assert.equal(await res.text(), 'Link expired');
    assert.ok(events().some(e => e.event === 'link-issued' && e.file === 'f1' && e.expires === l.expires * 1000));
});

test('the download button redirects across hosts; an offsite hop is offered to the client', async (t) => {
    const { base, cdn, sim } = await start(t, {
        redirectHops: 2,
        faults: [{ type: 'offsiteRedirect', at: 30, until: 40 }],
    });
    let res = await fetch(base + '/download/f1', { redirect: 'manual' });
    assert.equal(res.status, 302);
    const hop0 = res.headers.get('location');
    assert.ok(hop0.startsWith(cdn + '/dl/f1/'));
    res = await fetch(hop0, { redirect: 'manual' });
    assert.equal(res.status, 302);
    const hop1 = res.headers.get('location');
    assert.ok(hop1.startsWith(base + '/dl/f1/') && hop1.includes('hop=1'), 'back on the site host');
    res = await fetch(hop1, { redirect: 'manual' });
    const hop2 = res.headers.get('location');
    assert.ok(hop2.startsWith(cdn + '/dl/f1/') && hop2.includes('hop=2'));
    res = await fetch(hop2, { redirect: 'manual' });
    assert.equal(res.status, 200);
    await res.arrayBuffer();
    // Followed automatically the chain ends in the bytes too.
    assert.equal((await fetch(base + '/download/f2')).status, 200);

    sim.sim.clock.set(EPOCH + 35_000);
    res = await fetch(base + '/download/f1', { redirect: 'manual' });
    res = await fetch(res.headers.get('location'), { redirect: 'manual' });
    assert.equal(res.headers.get('location'), 'http://169.254.169.254/latest/meta-data/', 'a hop no allow-list may follow');
});

test('transfer faults: a cut body, a stalled body, a throttled body, a new ETag', async (t) => {
    const { base, sim } = await start(t, {
        signatureTtlS: 3600,
        faults: [
            { type: 'transferStall', at: 20, until: 30, mode: 'cut', afterBytes: 10_000, file: 'f1' },
            { type: 'transferStall', at: 30, until: 40, mode: 'stall', afterBytes: 5_000, stallS: 0.3 },
            { type: 'transferStall', at: 40, until: 50, mode: 'slow', bytesPerSecond: 200_000 },
            { type: 'etagChange', at: 60, file: 'f1' },
        ],
    });
    const clock = sim.sim.clock;
    const { url } = await link(base, 'f1');
    const size = Number((await fetch(url, { method: 'HEAD' })).headers.get('content-length'));
    const etag = (await fetch(url, { method: 'HEAD' })).headers.get('etag');

    clock.set(EPOCH + 25_000);
    let r = await rawGet(url);
    assert.equal(r.status, 200);
    assert.equal(r.complete, false, 'the connection was cut');
    assert.equal(r.bytes, 10_000);
    r = await rawGet(url, { range: 'bytes=10000-' });
    assert.equal(r.status, 206);
    assert.equal(r.bytes, Math.min(10_000, size - 10_000), 'every response is cut after 10 000 bytes');
    assert.equal((await rawGet((await link(base, 'f3')).url)).complete, true, 'the cut is limited to f1');

    clock.set(EPOCH + 35_000);
    r = await rawGet(url);
    assert.equal(r.complete, false);
    assert.equal(r.bytes, 5_000);
    assert.ok(r.ms >= 250, `held about 0.3 s, took ${r.ms} ms`);

    clock.set(EPOCH + 45_000);
    r = await rawGet(url, { range: 'bytes=0-39999' });
    assert.equal(r.complete, true);
    assert.equal(r.bytes, 40_000);
    assert.ok(r.ms >= 150, `throttled to 200 kB/s, took ${r.ms} ms`);

    clock.set(EPOCH + 61_000);
    const fresh = (await link(base, 'f1')).url;
    const now = await fetch(fresh, { method: 'HEAD' });
    assert.notEqual(now.headers.get('etag'), etag, 'the validator changed');
    const resumed = await fetch(fresh, { headers: { range: 'bytes=5000-', 'if-range': etag } });
    assert.equal(resumed.status, 200, 'a resume against the old ETag starts over');
    await resumed.arrayBuffer();

    const downloads = sim.memory.records.filter(x => x.type === 'response' && x.kind === 'download' && x.status !== 403);
    const cut = downloads.find(x => x.reason === 'cut');
    assert.equal(cut.bytes, 10_000);
    assert.equal(cut.planned, size);
    assert.ok(downloads.some(x => x.range === '10000-' + (size - 1)));
});

test('removed files, API faults and the referer rule', async (t) => {
    const { base, sim } = await start(t, {
        requireReferer: true,
        faults: [
            { type: 'fileRemoved', at: 30, file: 'f3' },
            { type: 'apiStatus', at: 40, until: 50, status: 503, api: 'link' },
            { type: 'apiStatus', at: 50, until: 60, status: 'malformed', api: 'page' },
        ],
    });
    assert.equal((await fetch(base + '/api/link', { method: 'POST', body: 'id=f1', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 403, 'no referer');
    const l = await link(base, 'f3', { referer: base + '/f/f3' });
    assert.ok(l.url);
    sim.sim.clock.set(EPOCH + 31_000);
    assert.equal((await fetch(base + '/f/f3')).status, 404);
    assert.equal((await fetch(l.url)).status, 404, 'the signed link of a removed file');
    assert.doesNotMatch(await (await fetch(base + '/a/al1')).text(), /data-file-id="f3"/);
    sim.sim.clock.set(EPOCH + 41_000);
    assert.equal((await fetch(base + '/api/link', { method: 'POST', body: '{"id":"f1"}', headers: { referer: base + '/f/f1', 'content-type': 'application/json' } })).status, 503);
    sim.sim.clock.set(EPOCH + 51_000);
    const res = await fetch(base + '/f/f1');
    assert.equal(res.status, 200);
    assert.doesNotMatch(await res.text(), /id="download"/, 'a challenge page instead of the file page');
});

test('file-host scenario validation', () => {
    const bad = () => validateScenario({ name: 'x', seed: 'x', sites: { 'file-host': {
        files: [{ id: 'a', name: 'A.mp4', album: 'missing', from: 'best' }, { id: 'a', name: 'B.mp4' }],
        faults: [{ type: 'transferStall', at: 1, until: 2, mode: 'jam' }, { type: 'fileRemoved', at: 3, file: 'zz' }],
    } } });
    assert.throws(bad, ScenarioError);
    try { bad(); } catch (error) {
        const text = error.problems.join('\n');
        assert.match(text, /files\[0\]\.from/);
        assert.match(text, /duplicate id "a"/);
        assert.match(text, /unknown album "missing"/);
        assert.match(text, /faults\[0\]\.mode/);
        assert.match(text, /unknown file "zz"/);
    }
});
