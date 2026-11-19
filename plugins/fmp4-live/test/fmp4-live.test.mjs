// fmp4-live against the simulator, in process: ephemeral ports on 127.0.0.1, a manual
// clock and tiny generated media (ffmpeg under nice). Every address and key comes from
// the config, as in the sites file.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FilePluginStore, PlaylistNotFoundError, SDK_VERSION, inspectFragment, normalizeRecordingId } from 'sdk';
import { MediaLibrary, SimClock, startSimulator } from 'simulator';
import { decodePlaylist, edgeOfUrl, plugin, readConfig } from '../dist/index.js';

const EPOCH = Date.parse('2026-06-01T12:00:00.000Z');
const KEYS = { k1: 'unit-secret-one', k2: 'unit-secret-two' };

let media = null;
// One tiny source per test process.
function library() {
    media ??= (async () => {
        const root = mkdtempSync(path.join(os.tmpdir(), 'fmp4-plugin-'));
        process.on('exit', () => rmSync(root, { recursive: true, force: true }));
        mkdirSync(path.join(root, 'in'));
        execFileSync('nice', ['-n', '19', 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000',
            '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-threads', '2', '-c:a', 'aac', '-b:a', '48k',
            path.join(root, 'in', 'Practice.mkv')]);
        const { prepAll } = await import('simulator');
        await prepAll({ input: path.join(root, 'in'), out: path.join(root, 'cache') });
        return MediaLibrary.load(path.join(root, 'cache'));
    })();
    return media;
}

function scenario() {
    return {
        name: 'fmp4 plug-in', seed: 'fmp4-plugin', epoch: EPOCH,
        sites: { 'fmp4-live': {
            edges: ['a', 'b', 'c'],
            obfuscation: { keys: KEYS, keyId: 'k1' },
            faults: [{ type: 'obfuscationKey', at: 100, keyId: 'k2' }],
            channels: [
                { id: '501', name: 'rally-one', obfuscated: true, schedule: { sessions: [{ start: 0, end: 600 }] },
                  renames: [{ at: 120, name: 'net-cord' }],
                  edges: [{ id: 'a' }, { id: 'b', lagMs: 300, pdtSkewMs: 15 }, { id: 'c' }],
                  faults: [
                      { type: 'edgeOutage', edge: 'a', at: 40, until: 50, status: 503 },
                      { type: 'damage', at: 60, until: 70, kind: 'zero-size-sample' },
                      { type: 'showState', at: 200, until: 220, state: 'group' },
                  ] },
                { id: '502', name: 'second-serve', schedule: { sessions: [{ start: 1000 }] } },
                { id: '503', name: 'last-point', schedule: { sessions: [{ start: 0, end: 90 }] } },
            ],
        } },
    };
}

function recordingLogger() {
    const lines = [];
    const at = (level) => (message, meta) => lines.push({ level, message, meta });
    return { lines, log: { debug: at('debug'), verbose: at('verbose'), info: at('info'), warn: at('warn'), error: at('error') } };
}

function tempDir(t, prefix) {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

async function start(t, at) {
    const clock = new SimClock({ mode: 'manual', at });
    const sim = await startSimulator({ scenario: scenario(), media: await library(), clock, autoPublish: false, memoryTruth: true, host: '127.0.0.1' });
    t.after(() => sim.close());
    const base = sim.urls['fmp4-live'];
    const site = async (config = {}, stateDir = tempDir(t, 'fmp4-state-')) => {
        const { lines, log } = recordingLogger();
        const instance = await plugin.create({
            siteId: 'fmp4-live', config: { baseUrl: base, playlistKeys: KEYS, pollIntervalMs: 2000, ...config },
            store: new FilePluginStore(stateDir),
            paths: { stateDir, downloadList: path.join(stateDir, 'list.txt'), browserProfiles: path.join(stateDir, 'profiles'), loginState: path.join(stateDir, 'login') },
            log, clock: { now: () => Date.now() },
            credentials: { read: async () => ({ record: null, writtenAtMs: null, readAtMs: Date.now() }) },
        });
        await instance.init?.();
        return { ...instance, lines, stateDir };
    };
    return { sim, clock, base, site };
}

const live = (id, recordingId = '') => ({ targetId: id, alias: 'x', recordingId, masterPlaylistUrl: '' });
const segmentUris = (text) => text.split('\n').filter((line) => line && !line.startsWith('#'));

test('the plug-in declares the SDK version and reads its config', () => {
    assert.equal(plugin.sdkVersion, SDK_VERSION);
    assert.equal(plugin.id, 'fmp4-live');
    const config = readConfig({ baseUrl: 'http://127.0.0.1:1/', playlistKeys: { k1: 's' } });
    assert.equal(config.baseUrl, 'http://127.0.0.1:1');
    assert.deepEqual(config.playlistKeys, { k1: 's' });
    assert.deepEqual(readConfig({ baseUrl: 'http://x' }).playlistKeys, {});
    assert.throws(() => readConfig({ playlistKeys: {} }), /baseUrl/);
    assert.throws(() => readConfig({ baseUrl: 'http://x', playlistKeys: { k1: '' } }), /playlistKeys/);
    assert.throws(() => readConfig({ baseUrl: 'http://x', playlistKeys: ['s'] }), /playlistKeys/);
});

test('catalog: "<name> <id>" lines, lookups by ID and by any name, links from the configured origin', async (t) => {
    const { clock, base, site } = await start(t, EPOCH + 30_000);
    const { catalog } = await site();
    const warnings = [];
    const warn = (message) => warnings.push(message);
    assert.deepEqual(catalog.parseTargetLine('rally-one 501', warn), { id: '501', label: 'rally-one' });
    assert.deepEqual(catalog.parseTargetLine(`${base}/rally-one 501`, warn), { id: '501', label: 'rally-one' });
    assert.deepEqual(warnings, []);
    assert.deepEqual(catalog.parseTargetLine('rally-one', warn), { id: '', label: 'rally-one' }, 'a bare name stays listed');
    assert.match(warnings.pop(), /no channel id/);
    for (const bad of ['rally one 501', 'rally-one abc', 'bad/name 5']) assert.equal(catalog.parseTargetLine(bad, warn), null, bad);
    assert.equal(warnings.length, 3, 'each malformed line is reported');
    assert.equal(catalog.parseTargetLine('rally-one abc'), null, 'and parsed silently without a reader that asks');
    assert.equal(catalog.parseTargetLine('# comment'), null);
    for (const line of ['rally-one 501', 'rally-one']) assert.equal(catalog.formatTargetLine(catalog.parseTargetLine(line)), line);
    assert.equal(catalog.listChangesBy, 'entry');

    assert.deepEqual(await catalog.resolveIdentifier('501'), { id: '501', label: 'rally-one' });
    assert.deepEqual(await catalog.resolveIdentifier('rally-one'), { id: '501', label: 'rally-one' });
    assert.equal(await catalog.resolveIdentifier('9999'), null);
    assert.equal(await catalog.resolveIdentifier('nobody-here'), null);
    clock.set(EPOCH + 130_000);
    assert.deepEqual(await catalog.resolveIdentifier(`${base}/rally-one`), { id: '501', label: 'net-cord' }, 'an old name finds the current one');
    assert.deepEqual(catalog.sourceLinks({ id: '501', label: 'net-cord' }), { channelUrl: `${base}/net-cord`, aliasUrl: null });

    const listed = [{ id: '501', label: 'rally-one' }, { id: '', label: 'pending-name' }];
    assert.equal(await catalog.resolveForRemove('501', listed), '501');
    assert.equal(await catalog.resolveForRemove('rally-one', listed), '501', 'the listed (old) label');
    assert.equal(await catalog.resolveForRemove('net-cord', listed), '501', 'the current name, by the site');
    assert.equal(await catalog.resolveForRemove(`${base}/net-cord`, listed), '501');
    assert.equal(await catalog.resolveForRemove('pending-name', listed), 'pending-name', 'an entry without an ID is keyed by its name');
    assert.equal(await catalog.resolveForRemove('nobody-here', listed), 'nobody-here');
});

test('the alias refresh reads every current name in bulk status batches', async (t) => {
    const { clock, site } = await start(t, EPOCH + 30_000);
    const { catalog } = await site();
    assert.equal(catalog.refreshAliases.intervalMs, 3_600_000);
    assert.equal(catalog.refreshAliases.keepHistory, undefined, 'the list takes the names; the plug-in keeps its own history');
    const ids = ['501', '502', '9999', ...Array.from({ length: 150 }, (_, i) => String(20_000 + i)), '501'];
    assert.deepEqual([...(await catalog.refreshAliases.run(ids))], [
        ['501', { current: 'rally-one', history: [] }], ['502', { current: 'second-serve', history: [] }],
    ], 'unknown IDs are left out');
    clock.set(EPOCH + 130_000);
    assert.equal((await catalog.refreshAliases.run(['501'])).get('501').current, 'net-cord');
});

test('lookup: public is live, private/group/offline are terminal; statusSince is the identity', async (t) => {
    const { clock, base, site } = await start(t, EPOCH + 30_000);
    const { capture } = await site();
    const listed = [{ id: '502', label: 'second-serve' }, { id: '501', label: 'rally-one' }, { id: '', label: 'unresolved' }];
    assert.equal(await capture.lookup([{ id: '', label: 'unresolved' }], new Map()), null, 'nothing resolved: no request');
    const snapshot = await capture.lookup(listed, new Map());
    assert.deepEqual([...snapshot.live.keys()], ['501']);
    assert.deepEqual([...snapshot.terminalTargetIds], ['502']);
    const status = (await (await fetch(`${base}/api/channels/status?ids=501`)).json()).channels[0];
    assert.equal(snapshot.live.get('501').recordingId, normalizeRecordingId(status.statusSince));
    const raw = (await (await fetch(`${base}/api/channels/status?ids=502,501`)).json()).channels.map((c) => String(c.id));
    assert.deepEqual(snapshot.startOrder, raw, 'captures start in the order the site answers');

    clock.set(EPOCH + 210_000);
    const group = await capture.lookup(listed, new Map());
    assert.equal(group.live.size, 0);
    assert.ok(group.terminalTargetIds.has('501'), 'a group show is not recordable');
    clock.set(EPOCH + 225_000);
    const back = await capture.lookup(listed, new Map());
    assert.notEqual(back.live.get('501').recordingId, snapshot.live.get('501').recordingId, 'back to public is a new recording');
});

test('the status check is split into batches the site accepts', async (t) => {
    const { site } = await start(t, EPOCH + 30_000);
    const { capture } = await site();
    const many = Array.from({ length: 230 }, (_, i) => ({ id: String(10_000 + i), label: `c${i}` }));
    const snapshot = await capture.lookup([...many, { id: '501', label: 'rally-one' }], new Map());
    assert.ok(snapshot, 'more than one request of up to 100 IDs');
    assert.deepEqual([...snapshot.live.keys()], ['501']);
});

test('renames are logged once, kept durably, and match old folders to their channel', async (t) => {
    const { clock, site } = await start(t, EPOCH + 30_000);
    const first = await site();
    const listed = [{ id: '501', label: 'rally-one' }];
    await first.capture.lookup(listed, new Map());
    clock.set(EPOCH + 130_000);
    const snapshot = await first.capture.lookup(listed, new Map());
    assert.equal(snapshot.live.get('501').alias, 'net-cord', 'a new capture is named after the current name');
    await first.capture.lookup(listed, new Map());
    assert.equal(first.lines.filter((l) => l.message === 'Channel 501 is now named net-cord (was rally-one)').length, 1);
    const stored = JSON.parse(readFileSync(path.join(first.stateDir, 'names.json'), 'utf8'));
    assert.deepEqual(stored['501'], ['net-cord', 'rally-one']);
    // A restarted downloader (same state directory) still knows the old name.
    const again = await site({}, first.stateDir);
    assert.equal(again.capture.targetIdForFolderAlias('rally-one', listed), '501');
    assert.equal(again.capture.targetIdForFolderAlias('somebody-else', listed), null);
});

test('edges: edgeOf, variantKey, and failover to a healthy edge when one fails', async (t) => {
    const { clock, site } = await start(t, EPOCH + 30_000);
    const { capture } = await site();
    const provider = capture.provider;
    await capture.lookup([{ id: '501', label: 'rally-one' }], new Map());
    const started = await capture.resolveMaster(live('501'));
    assert.equal(edgeOfUrl(started.masterPlaylistUrl), 'a');
    assert.equal(started.alias, 'rally-one');
    const variant = await provider.parseMasterPlaylist(started.masterPlaylistUrl);
    assert.equal(provider.edgeOf(variant), 'a');
    assert.deepEqual(provider.describeVariant(variant), { name: 'source', resolution: '320x180', bandwidth: provider.describeVariant(variant).bandwidth, isMasterBest: true });

    clock.set(EPOCH + 45_000);
    const session = provider.createDownloadSession();
    assert.equal(await session.fetchPlaylist(variant), null);
    assert.deepEqual(session.getLastPlaylistFailure(), { kind: 'http', status: 503 });
    const recovered = await provider.recoverVariant(started.masterPlaylistUrl);
    assert.equal(provider.edgeOf(recovered), 'b', 'the failed edge goes to the back');
    assert.equal(provider.variantKey(recovered), provider.variantKey(variant), 'the same rendition on another copy');
    assert.notEqual(recovered, variant);
    assert.ok(await provider.createDownloadSession().fetchPlaylist(recovered));
    // A new start (or retry) prefers an edge that has not failed lately.
    assert.equal(edgeOfUrl((await capture.resolveMaster(live('501'))).masterPlaylistUrl), 'b');
});

test('obfuscated playlists decode with the configured keys, across a key rotation', async (t) => {
    const { clock, site } = await start(t, EPOCH + 30_000);
    const full = await site();
    const partial = await site({ playlistKeys: { k1: KEYS.k1 } });
    const { masterPlaylistUrl } = await full.capture.resolveMaster(live('501'));
    const variant = await full.capture.provider.parseMasterPlaylist(masterPlaylistUrl);
    const read = async (instance) => {
        const session = instance.capture.provider.createDownloadSession();
        return { text: await session.fetchPlaylist(variant), failure: session.getLastPlaylistFailure() };
    };
    const before = await read(full);
    assert.doesNotMatch(before.text, /#EXT-X-OBF-/);
    const uri = segmentUris(before.text).at(-1);
    assert.doesNotMatch(uri, /obfuscated/);
    const segment = await full.capture.provider.createDownloadSession().fetchSegment(new URL(uri, variant).href);
    assert.ok(segment.data.length > 0, 'a decoded URI serves media');
    assert.ok((await read(partial)).text, 'k1 is enough before the rotation');

    clock.set(EPOCH + 110_000);
    assert.doesNotMatch((await read(full)).text, /#EXT-X-OBF-/, 'k2 after the rotation');
    for (let i = 0; i < 3; i++) {
        const { text, failure } = await read(partial);
        assert.equal(text, null);
        assert.deepEqual(failure, { kind: 'decrypt' });
    }
    assert.equal(partial.lines.filter((l) => /Cannot decode playlists with key k2: unknown-key/.test(l.message)).length, 1, 'warned once');
    assert.equal(decodePlaylist('#EXTM3U\n#EXT-X-OBF-KEY:ID=k1\n#EXT-X-OBF-URI:00000000.AAAA\nx.m4s\n', KEYS).ok, false, 'a wrong check is undecodable');
});

test('zero-size sample entries are repaired on arrival; the repair is reported', async (t) => {
    const { clock, site } = await start(t, EPOCH + 66_000);
    const { capture } = await site();
    const provider = capture.provider;
    const { masterPlaylistUrl } = await capture.resolveMaster(live('501'));
    const variant = await provider.parseMasterPlaylist(masterPlaylistUrl);
    const session = provider.createDownloadSession();
    const uri = new URL(segmentUris(await session.fetchPlaylist(variant)).at(-1), variant).href;
    const served = Buffer.from(await (await fetch(uri)).arrayBuffer());
    assert.ok(inspectFragment(served).zeroSizeSamples > 0, 'the site serves a damaged fragment');
    const fetched = await session.fetchSegment(uri);
    assert.match(fetched.repair, /^dropped \d+ zero-size sample entr(y|ies)$/);
    assert.equal(inspectFragment(fetched.data).zeroSizeSamples, 0);

    const dir = tempDir(t, 'fmp4-seg-');
    writeFileSync(path.join(dir, 'repaired.m4s'), fetched.data);
    writeFileSync(path.join(dir, 'served.m4s'), served);
    const verdict = await provider.validateSegment(path.join(dir, 'repaired.m4s'));
    assert.equal(verdict.valid, true);
    assert.ok(verdict.duration > 1.5 && verdict.duration < 2.5, `duration ${verdict.duration}`);
    assert.equal((await provider.validateSegment(path.join(dir, 'served.m4s'))).valid, false);

    clock.set(EPOCH + 80_000);
    const clean = new URL(segmentUris(await session.fetchPlaylist(variant)).at(-1), variant).href;
    assert.equal((await session.fetchSegment(clean)).repair, undefined, 'undamaged fragments pass untouched');
});

test('an ended stream ends the recording; other failures are retried', async (t) => {
    const { clock, site } = await start(t, EPOCH + 30_000);
    const { capture } = await site();
    const { masterPlaylistUrl } = await capture.resolveMaster(live('503'));
    const variant = await capture.provider.parseMasterPlaylist(masterPlaylistUrl);
    clock.set(EPOCH + 110_000);
    await assert.rejects(capture.provider.createDownloadSession().fetchPlaylist(variant), PlaylistNotFoundError);
    // A segment failure is the copy's: not retried in place, the session starts again.
    const failed = await capture.provider.createDownloadSession().fetchSegment(variant.replace(/playlist\.m3u8$/, 'nothing.m4s'));
    assert.equal(failed.data, null);
    assert.equal(failed.retryable, false);
    assert.equal(failed.status, 404);
});

test('shouldRetry restarts on the healthiest edge while the identity holds', async (t) => {
    const { clock, site } = await start(t, EPOCH + 30_000);
    const { capture } = await site();
    const listed = [{ id: '501', label: 'rally-one' }];
    const snapshot = await capture.lookup(listed, new Map());
    const recordingId = snapshot.live.get('501').recordingId;
    const context = { streamerId: '501', recordingId, lookupAlias: 'rally-one', exitReason: 'segment-failed', lastMasterUrl: 'http://old/', lastLiveUrl: null };
    assert.equal(edgeOfUrl(await capture.provider.shouldRetry(context)), 'a');
    assert.equal(await capture.provider.shouldRetry({ ...context, exitReason: 'aborted' }), null);
    assert.equal(await capture.provider.shouldRetry({ ...context, recordingId: 'another' }), 'http://old/');
    clock.set(EPOCH + 210_000);
    await capture.lookup(listed, new Map());
    assert.equal(await capture.provider.shouldRetry(context), 'http://old/', 'a group show: the core confirms offline');
});

test('access diagnostics observe every edge and change nothing', async (t) => {
    const { clock, site } = await start(t, EPOCH + 30_000);
    const { capture } = await site();
    const provider = capture.provider;
    await capture.lookup([{ id: '501', label: 'rally-one' }], new Map());
    const { masterPlaylistUrl, recordingId } = await capture.resolveMaster(live('501'));
    const variant = await provider.parseMasterPlaylist(masterPlaylistUrl);
    clock.set(EPOCH + 45_000);
    const stream = /\/hls\/([^/]+)\//.exec(variant)[1];
    const orderBefore = provider.edgeOrder(stream, ['a', 'b', 'c']);
    const evidence = await provider.diagnoseAccessFailure({
        stage: 'playlist', provider: 'fmp4-live', streamerId: '501', alias: 'rally-one', recordingId,
        masterUrl: masterPlaylistUrl, liveUrl: variant, failure: { kind: 'http', status: 503 },
    });
    assert.equal(evidence.behavior, 'observe-only');
    assert.equal(evidence.failingEdge, 'a');
    assert.equal(evidence.providerState.source, 'fresh-status');
    assert.equal(evidence.providerState.status, 'public');
    assert.deepEqual(evidence.stream, { current: true, available: true, active: true });
    assert.deepEqual(evidence.edges.map((e) => [e.edge, e.master.status, e.variant.status, e.variant.decodable ?? null]),
        [['a', 503, 503, null], ['b', 200, 200, true], ['c', 200, 200, true]]);
    assert.deepEqual(provider.edgeOrder(stream, ['a', 'b', 'c']), orderBefore, 'probes record no edge failure');
});
