// ladder-live against the simulator, in process: ephemeral ports on 127.0.0.1, a
// manual clock and tiny generated media (ffmpeg under nice). Every address comes from
// the config, as in the sites file.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PlaylistNotFoundError, SDK_VERSION } from 'sdk';
import { MediaLibrary, SimClock, TruthIndex, prepAll, startSimulator } from 'simulator';
import { modeOfUrl, parseLadder, plugin, readConfig, selectPlaylist } from '../dist/index.js';

const EPOCH = Date.parse('2026-06-01T12:00:00.000Z');

let media = null;
// One tiny source per test process.
function library() {
    media ??= (async () => {
        const root = mkdtempSync(path.join(os.tmpdir(), 'ladder-plugin-'));
        process.on('exit', () => rmSync(root, { recursive: true, force: true }));
        mkdirSync(path.join(root, 'in'));
        execFileSync('nice', ['-n', '19', 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
            '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-threads', '2', '-c:a', 'aac', '-b:a', '48k',
            path.join(root, 'in', 'Practice.mkv')]);
        await prepAll({ input: path.join(root, 'in'), out: path.join(root, 'cache') });
        return { root, library: MediaLibrary.load(path.join(root, 'cache')) };
    })();
    return media;
}

function scenario() {
    return {
        name: 'ladder plug-in', seed: 'ladder-plugin', epoch: EPOCH,
        sites: { 'ladder-live': {
            pageSize: 1,
            channels: [
                { id: '1001', name: 'court-one', edges: [{ id: 'a', firstSequence: 1100 }], schedule: { sessions: [{ start: 0, end: 100 }, { start: 200 }] },
                  faults: [{ type: 'restart', at: 40, value: 1 }] },
                { id: '1002', name: 'court-two', schedule: { sessions: [{ start: 0 }] }, faults: [{ type: 'paid', at: 50, until: 60 }] },
                { id: '1003', name: 'court-three', schedule: { sessions: [{ start: 500 }] } },
            ],
        } },
    };
}

function recordingLogger() {
    const lines = [];
    const at = (level) => (message, meta) => lines.push({ level, message, meta });
    return { lines, log: { debug: at('debug'), verbose: at('verbose'), info: at('info'), warn: at('warn'), error: at('error') } };
}

async function start(t, at) {
    const { library: lib } = await library();
    const clock = new SimClock({ mode: 'manual', at });
    const sim = await startSimulator({ scenario: scenario(), media: lib, clock, autoPublish: false, memoryTruth: true, host: '127.0.0.1' });
    t.after(() => sim.close());
    const site = (config = {}) => {
        const { lines, log } = recordingLogger();
        const stateDir = mkdtempSync(path.join(os.tmpdir(), 'ladder-state-'));
        t.after(() => rmSync(stateDir, { recursive: true, force: true }));
        const instance = plugin.create({
            siteId: 'ladder-live', config: { baseUrl: sim.urls['ladder-live'], pollIntervalMs: 2000, ...config },
            store: { read: async () => undefined, write: async () => {}, update: async (_k, f) => f(undefined), delete: async () => {} },
            paths: { stateDir, downloadList: path.join(stateDir, 'list.txt'), browserProfiles: path.join(stateDir, 'profiles'), loginState: path.join(stateDir, 'login') },
            log, clock: { now: () => Date.now() },
            credentials: { read: async () => ({ record: null, writtenAtMs: null, readAtMs: Date.now() }) },
        });
        return { ...instance, lines };
    };
    return { sim, clock, base: sim.urls['ladder-live'], site };
}

const targets = (...ids) => ids.map((id) => ({ id, label: `label-${id}` }));

test('the plug-in declares the SDK version and reads its config', () => {
    assert.equal(plugin.sdkVersion, SDK_VERSION);
    assert.equal(plugin.id, 'ladder-live');
    const config = readConfig({ baseUrl: 'http://127.0.0.1:1/' });
    assert.equal(config.baseUrl, 'http://127.0.0.1:1');
    assert.equal(config.latency, 'middle');
    assert.equal(config.maxHeight, null);
    assert.throws(() => readConfig({}), /baseUrl/);
    assert.throws(() => readConfig({ baseUrl: 'http://x', latency: 'fast' }), /latency/);
    assert.throws(() => readConfig({ baseUrl: 'http://x', pollIntervalMs: 0 }), /pollIntervalMs/);
});

test('catalog: list lines, the member lookup and links from the configured origin', async (t) => {
    const { base, site } = await start(t, EPOCH + 30_000);
    const { catalog } = site();
    const warnings = [];
    const warn = (message) => warnings.push(message);
    assert.deepEqual(catalog.parseTargetLine('1001 centre court', warn), { id: '1001', label: 'centre court' });
    assert.deepEqual(catalog.parseTargetLine(`${base}/1002`, warn), { id: '1002', label: '1002' });
    assert.equal(catalog.parseTargetLine('# comment', warn), null);
    assert.equal(catalog.parseTargetLine('   ', warn), null);
    assert.deepEqual(warnings, []);
    assert.equal(catalog.parseTargetLine('court-one', warn), null);
    assert.equal(warnings.length, 1, 'a malformed line is reported to the reader that asks');
    assert.match(warnings[0], /court-one/);
    assert.equal(catalog.parseTargetLine('court-one'), null, 'and parsed silently otherwise');
    assert.equal(catalog.formatTargetLine({ id: '1001', label: 'centre court' }), '1001 centre court');
    assert.equal(catalog.formatTargetLine({ id: '1001', label: '1001' }), '1001');
    for (const line of ['1001 centre court', '1002']) assert.equal(catalog.formatTargetLine(catalog.parseTargetLine(line)), line);

    assert.deepEqual(await catalog.resolveIdentifier('1001'), { id: '1001', label: 'court-one' });
    assert.deepEqual(await catalog.resolveIdentifier(`${base}/1002`), { id: '1002', label: 'court-two' });
    assert.equal(await catalog.resolveIdentifier('9999'), null, 'an unknown channel has an empty profile');
    assert.equal(await catalog.resolveIdentifier('not-a-channel'), null);
    assert.equal(await catalog.exists('1003'), true);
    assert.deepEqual(catalog.sourceLinks({ id: '1001', label: 'x' }), { channelUrl: `${base}/1001`, aliasUrl: null });
    const listed = [{ id: '1001', label: 'centre court' }, { id: '1002', label: '1002' }];
    assert.equal(catalog.resolveForRemove('1002', listed), '1002');
    assert.equal(catalog.resolveForRemove(`${base}/1001`, listed), '1001');
    assert.equal(catalog.resolveForRemove('centre court', listed), '1001', 'a listed name finds its ID');
    assert.equal(catalog.resolveForRemove('nobody', listed), 'nobody');
});

test('lookup reads every page; paid and offline channels are terminal; the identity is started_at', async (t) => {
    const { clock, site } = await start(t, EPOCH + 55_000);
    const { capture } = site();
    assert.equal(await capture.lookup([], new Map()), null, 'nothing listed: no request, no snapshot');
    const snapshot = await capture.lookup(targets('1001', '1002', '1003'), new Map());
    assert.deepEqual([...snapshot.live.keys()], ['1001']);
    assert.equal(snapshot.live.get('1001').recordingId, String(Math.floor(EPOCH / 1000)));
    assert.equal(snapshot.live.get('1001').alias, 'label-1001');
    assert.deepEqual([...snapshot.terminalTargetIds].sort(), ['1002', '1003'], 'paid (1002) and offline (1003)');
    clock.set(EPOCH + 61_000);
    const later = await capture.lookup(targets('1001', '1002'), new Map());
    assert.deepEqual([...later.live.keys()].sort(), ['1001', '1002'], 'the paid show is over');
    assert.equal(capture.pollIntervalMs, 2000);
    assert.equal(capture.mediaFormat, 'ts');
});

test('the handshake gives the best rung within the height cap at the configured latency', async (t) => {
    const { site } = await start(t, EPOCH + 30_000);
    const top = site();
    const live = { targetId: '1001', alias: 'court-one', recordingId: String(Math.floor(EPOCH / 1000)), masterPlaylistUrl: '' };
    const resolved = await top.capture.resolveMaster(live);
    assert.equal(modeOfUrl(resolved.masterPlaylistUrl), 52, 'top rung (quality 5), middle latency');
    assert.deepEqual(top.capture.provider.describeVariant(resolved.masterPlaylistUrl), {
        name: 'mode 52', resolution: '320x180', bandwidth: top.capture.provider.describeVariant(resolved.masterPlaylistUrl).bandwidth, isMasterBest: true,
    });

    const capped = site({ maxHeight: 130, latency: 'low' });
    const lower = await capped.capture.resolveMaster(live);
    assert.equal(modeOfUrl(lower.masterPlaylistUrl), 40, 'the 120p rung, low latency');
    assert.equal(capped.capture.provider.describeVariant(lower.masterPlaylistUrl).isMasterBest, false);

    const none = site({ maxHeight: 50 });
    assert.equal(await none.capture.resolveMaster(live), null);
    assert.ok(none.lines.some((l) => l.level === 'warn' && /no playlist within the quality limits/.test(l.message)));
});

test('ladder selection: wanted latency first, then low, middle, high', () => {
    const master = ['#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=900,RESOLUTION=640x360', 'x/50/playlist.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=500,RESOLUTION=426x240', 'x/40/playlist.m3u8'].join('\n');
    const rungs = parseLadder(master, 'http://h/s/master.m3u8');
    assert.deepEqual(rungs.map((r) => [r.quality, r.height]), [[5, 360], [4, 240]]);
    const offers = [50, 51, 41, 42].map((mode) => ({ mode, url: `http://h/s/${mode}/playlist.m3u8` }));
    assert.equal(selectPlaylist(offers, rungs, { latency: 'middle', maxHeight: null }).offer.mode, 50, 'no middle at the top rung: low');
    assert.equal(selectPlaylist(offers, rungs, { latency: 'high', maxHeight: null }).offer.mode, 51);
    assert.equal(selectPlaylist(offers, rungs, { latency: 'middle', maxHeight: 300 }).offer.mode, 42);
    assert.equal(selectPlaylist(offers, [], { latency: 'low', maxHeight: 300 }), null, 'unknown heights only without a cap');
});

test('segments arrive byte-exact and numbering restarts pass through to the core', async (t) => {
    const { sim, clock, site } = await start(t, EPOCH + 38_000);
    const { capture } = site();
    const { masterPlaylistUrl: url } = await capture.resolveMaster({ targetId: '1001', alias: 'a', recordingId: String(Math.floor(EPOCH / 1000)), masterPlaylistUrl: '' });
    assert.equal(await capture.provider.parseMasterPlaylist(url), url, 'a media playlist is captured as it is');
    const session = capture.provider.createDownloadSession();
    const before = await session.fetchPlaylist(url);
    assert.ok(Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(before)[1]) >= 1100);
    const uri = before.split('\n').filter((l) => l && !l.startsWith('#')).at(-1);
    const segment = await session.fetchSegment(new URL(uri, url).href);
    assert.ok(segment.data.length > 0);

    clock.set(EPOCH + 45_000);
    const after = await session.fetchPlaylist(url);
    assert.equal(Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(after)[1]), 1);

    sim.sim.publisher.tick();
    const truth = new TruthIndex(sim.memory.records);
    const hash = createHash('sha256').update(segment.data).digest('hex');
    assert.ok(truth.available({ site: 'ladder-live', channel: '1001' }).some((a) => a.sha256 === hash), 'the bytes are the published segment');

    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'ladder-seg-')), 'seg.ts');
    t.after(() => rmSync(path.dirname(file), { recursive: true, force: true }));
    writeFileSync(file, segment.data);
    const verdict = await capture.provider.validateSegment(file);
    assert.equal(verdict.valid, true);
    assert.equal(verdict.dimensions?.height, 180);
    writeFileSync(file, '');
    assert.equal((await capture.provider.validateSegment(file)).valid, false);
});

test('a playlist 403 is a paid show (retry) or the stream end (ends the recording)', async (t) => {
    const { clock, site } = await start(t, EPOCH + 45_000);
    const paid = site();
    await paid.capture.lookup(targets('1002'), new Map());
    const { masterPlaylistUrl: paidUrl } = await paid.capture.resolveMaster({ targetId: '1002', alias: 'b', recordingId: String(Math.floor(EPOCH / 1000)), masterPlaylistUrl: '' });
    clock.set(EPOCH + 55_000);
    const paidSession = paid.capture.provider.createDownloadSession();
    assert.equal(await paidSession.fetchPlaylist(paidUrl), null);
    assert.deepEqual(paidSession.getLastPlaylistFailure(), { kind: 'http', status: 403 });
    // While paid, the control channel refuses: no stream to start.
    assert.equal(await paid.capture.resolveMaster({ targetId: '1002', alias: 'b', recordingId: String(Math.floor(EPOCH / 1000)), masterPlaylistUrl: '' }), null);

    const ended = site();
    const { masterPlaylistUrl: endedUrl } = await ended.capture.resolveMaster({ targetId: '1001', alias: 'a', recordingId: String(Math.floor(EPOCH / 1000)), masterPlaylistUrl: '' });
    clock.set(EPOCH + 101_000);
    await assert.rejects(ended.capture.provider.createDownloadSession().fetchPlaylist(endedUrl), PlaylistNotFoundError);
});

test('shouldRetry: a fresh handshake for the same live broadcast, else the previous URL', async (t) => {
    const { clock, site } = await start(t, EPOCH + 30_000);
    const { capture } = site();
    const recordingId = String(Math.floor(EPOCH / 1000));
    await capture.lookup(targets('1001', '1002'), new Map());
    const context = { streamerId: '1001', recordingId, lookupAlias: 'a', exitReason: 'stale-timeout', lastMasterUrl: 'http://old/', lastLiveUrl: null };
    const fresh = await capture.provider.shouldRetry(context);
    assert.equal(modeOfUrl(fresh), 52);
    assert.equal(await capture.provider.shouldRetry({ ...context, exitReason: 'aborted' }), null);
    assert.equal(await capture.provider.shouldRetry({ ...context, recordingId: '1' }), 'http://old/', 'another broadcast: keep the URL');
    clock.set(EPOCH + 55_000);
    await capture.lookup(targets('1002'), new Map());
    assert.equal(await capture.provider.shouldRetry({ ...context, streamerId: '1002' }), 'http://old/', 'paid: keep the URL');
    assert.equal(await capture.provider.recoverVariant(fresh), null, 'one copy: no failover');
});
