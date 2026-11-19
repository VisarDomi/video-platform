import assert from 'node:assert/strict';
import test from 'node:test';
import { SimClock } from '../dist/clock.js';
import { startSimulator } from '../dist/serve.js';
import { modeOf } from '../dist/sites/ladder-live.js';
import { TruthIndex } from '../dist/truth/query.js';
import { EPOCH, sharedLibrary, segmentsOf, variantsOf } from './helpers.mjs';

function scenario(extra = {}, faults = []) {
    return {
        name: 'ladder test', seed: 'ladder-seed', epoch: EPOCH,
        sites: { 'ladder-live': {
            pageSize: 1,
            channels: [
                { id: '1001', name: 'court-one', startPosition: 0, edges: [{ id: 'a', firstSequence: 1100 }], schedule: { sessions: [{ start: 0, end: 100 }, { start: 200 }] }, faults },
                { id: '1002', name: 'court-two', schedule: { sessions: [{ start: 0 }] }, faults: [{ type: 'paid', at: 50, until: 60 }] },
            ],
            ...extra,
        } },
    };
}

async function start(t, extra, faults, at = EPOCH + 30_000) {
    const media = await sharedLibrary();
    const clock = new SimClock({ mode: 'manual', at });
    const sim = await startSimulator({ scenario: scenario(extra, faults), media: media.library, clock, autoPublish: false, memoryTruth: true });
    t.after(() => sim.close());
    return { sim, clock, base: sim.urls['ladder-live'] };
}

const postForm = (url, fields) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });

async function handshake(base, channelId, mode) {
    const opened = await (await postForm(base + '/api/control/open', { channel_id: channelId, mode: 'play' })).json();
    assert.equal(opened.status, 0);
    const control = opened.url;
    let after = 0;
    const recv = async (wait = 0) => {
        const res = await fetch(`${control}/recv?after=${after}&wait=${wait}`);
        if (res.status !== 200) return { status: res.status, messages: [] };
        const body = await res.json();
        if (body.messages.length) after = body.messages.at(-1).index;
        return { status: 200, messages: body.messages.map(m => m.message) };
    };
    const send = message => fetch(`${control}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) });
    const first = await recv();
    assert.deepEqual(first.messages, [{ name: 'ready' }]);
    return { control, recv, send };
}

test('paged channel list with paid flags, and the member API', async (t) => {
    const { clock, base } = await start(t, {}, [], EPOCH + 55_000);
    let body = await (await fetch(base + '/api/channels?page=1')).json();
    assert.equal(body.pageCount, 2);
    assert.deepEqual(body.channel.map(c => c.id), ['1001']);
    assert.equal(body.channel[0].started_at, Math.floor(EPOCH / 1000));
    body = await (await fetch(base + '/api/channels?page=2')).json();
    assert.deepEqual(body.channel.map(c => [c.id, c.paid]), [['1002', 1]]);
    clock.set(EPOCH + 61_000);
    body = await (await fetch(base + '/api/channels?page=2')).json();
    assert.equal(body.channel[0].paid, 0);
    const member = await (await postForm(base + '/api/member', { channel_id: '1001' })).json();
    assert.deepEqual(member, { profile: { id: '1001', name: 'court-one' } });
    assert.deepEqual(await (await postForm(base + '/api/member', { channel_id: '424242' })).json(), { profile: {} });
});

test('nobody live is an empty channel array; faults are errors or other shapes', async (t) => {
    const { clock, base } = await start(t, { channels: [{ id: '7', name: 'late', schedule: { sessions: [{ start: 500 }] } }],
        faults: [{ type: 'apiStatus', at: 10, until: 20, status: 502 }, { type: 'apiStatus', at: 20, until: 30, status: 'empty', api: 'channels' }] }, [], EPOCH + 5_000);
    assert.deepEqual((await (await fetch(base + '/api/channels')).json()).channel, []);
    clock.set(EPOCH + 15_000);
    assert.equal((await fetch(base + '/api/channels')).status, 502);
    clock.set(EPOCH + 25_000);
    assert.deepEqual(await (await fetch(base + '/api/channels')).json(), {});
});

test('the control handshake answers by request id and returns the URL for the asked mode', async (t) => {
    const { clock, base } = await start(t);
    const { recv, send } = await handshake(base, '1001');
    const mode = modeOf(0, 2);
    assert.equal(mode, 52);
    await send({ name: 'get_stream_info', id: 7, arguments: { mode } });
    clock.advance(10_000); // long enough for an unsolicited viewer count
    await send({ name: 'heartbeat', id: 8, arguments: {} });
    const { messages } = await recv();
    const info = messages.find(m => m.name === 'reply' && m.id === 7);
    assert.ok(info, 'reply carries the request id');
    assert.ok(messages.some(m => m.name === 'viewers'), 'unsolicited messages arrive in between');
    assert.deepEqual(messages.find(m => m.id === 8).arguments, { status: 0 });
    assert.match(info.arguments.url, /\/52\/playlist\.m3u8$/);
    assert.equal(info.arguments.playlists.length, 9, 'three rungs at three latencies');
    assert.deepEqual(info.arguments.playlists.filter(p => p.latency === 'middle').map(p => p.mode), [52, 42, 32]);

    const master = await (await fetch(info.arguments.master)).text();
    const variants = variantsOf(master);
    assert.equal(variants.length, 3);
    assert.ok(variants[0].height > variants[1].height && variants[1].height > variants[2].height, 'a quality ladder');
    const media = segmentsOf(await (await fetch(info.arguments.url)).text());
    assert.equal(media.segments.length, 4);
    const seg = await fetch(new URL(media.segments[0].uri, info.arguments.url));
    assert.equal(seg.status, 200);
    assert.equal(seg.headers.get('content-type'), 'video/mp2t');

    const unknown = await (await postForm(base + '/api/control/open', { channel_id: '9999' })).json();
    assert.deepEqual(unknown, { status: 2, reason: 'offline' });
});

test('a long poll returns as soon as a reply is queued', async (t) => {
    const { base } = await start(t);
    const { recv, send } = await handshake(base, '1001');
    const started = Date.now();
    const pending = recv(5000);
    await new Promise(r => setTimeout(r, 100));
    await send({ name: 'heartbeat', id: 1 });
    const { messages } = await pending;
    assert.equal(messages[0].id, 1);
    assert.ok(Date.now() - started < 3000);
});

test('at stream end the master answers 403 and the control channel closes', async (t) => {
    const { clock, base } = await start(t, {}, [], EPOCH + 90_000);
    const { recv, send } = await handshake(base, '1001');
    await send({ name: 'get_stream_info', id: 1, arguments: { mode: 50 } });
    const info = (await recv()).messages.find(m => m.id === 1).arguments;
    assert.equal((await fetch(info.master)).status, 200);
    clock.set(EPOCH + 101_000);
    assert.equal((await fetch(info.master)).status, 403);
    assert.equal((await fetch(info.url)).status, 403);
    const closing = await recv();
    assert.deepEqual(closing.messages.at(-1), { name: 'closed', arguments: { code: 4512, reason: 'stream ended' } });
    assert.equal((await recv()).status, 410);
    // The old session's URLs stay forbidden after the channel returns.
    clock.set(EPOCH + 230_000);
    assert.equal((await fetch(info.master)).status, 403);
    const fresh = await handshake(base, '1001');
    await fresh.send({ name: 'get_stream_info', id: 2 });
    const next = (await fresh.recv()).messages.find(m => m.id === 2).arguments;
    assert.notEqual(next.master, info.master);
    assert.equal((await fetch(next.master)).status, 200);
});

test('a scenario can make the ended master empty instead', async (t) => {
    const { clock, base } = await start(t, { endMaster: 'empty' }, [], EPOCH + 90_000);
    const { recv, send } = await handshake(base, '1001');
    await send({ name: 'get_stream_info', id: 1 });
    const info = (await recv()).messages.find(m => m.id === 1).arguments;
    clock.set(EPOCH + 101_000);
    const res = await fetch(info.master);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '#EXTM3U\n');
});

test('numbering restarts mid-stream (1100s to 1) and the truth log records both runs', async (t) => {
    const { sim, clock, base } = await start(t, {}, [{ type: 'restart', at: 40, value: 1 }], EPOCH + 39_000);
    const { recv, send } = await handshake(base, '1001');
    await send({ name: 'get_stream_info', id: 1, arguments: { mode: 50 } });
    const url = (await recv()).messages.find(m => m.id === 1).arguments.url;
    const before = segmentsOf(await (await fetch(url)).text());
    assert.ok(before.mediaSequence >= 1100);
    clock.set(EPOCH + 45_000);
    const after = segmentsOf(await (await fetch(url)).text());
    assert.equal(after.mediaSequence, 1);
    sim.sim.publisher.tick();
    const truth = new TruthIndex(sim.memory.records);
    const top = sim.sim.engine.channel('ladder-live', '1001').renditions[0].id;
    const seqs = truth.available({ site: 'ladder-live', channel: '1001', tier: top }).map(s => s.seq);
    assert.ok(seqs.includes(1) && seqs.some(s => s >= 1100));
    assert.equal(truth.sessions({ site: 'ladder-live', channel: '1001' })[0].recordingId, String(Math.floor(EPOCH / 1000)));
});

test('playlists can require the site origin', async (t) => {
    const { base } = await start(t, { requireOrigin: true });
    const { recv, send } = await handshake(base, '1001');
    await send({ name: 'get_stream_info', id: 1 });
    const info = (await recv()).messages.find(m => m.id === 1).arguments;
    assert.equal((await fetch(info.master)).status, 403);
    assert.equal((await fetch(info.master, { headers: { origin: base } })).status, 200);
});
