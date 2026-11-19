// The generic discovery loop with a fake site plug-in: the session rules are the core's,
// whatever the site.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import timersPromises from 'node:timers/promises';

// The recording folders live under the downloads root, fixed when the modules load.
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'discovery-loop-'));
process.env.VIDEO_DOWNLOADS_ROOT = path.join(sandbox, 'downloads');
test.after(() => rm(sandbox, { recursive: true, force: true }));

const { DiscoveryLoop } = await import('../dist/services/common/discoveryLoop.js');
const { formatSegmentName } = await import('../dist/services/download/segmentIdentity.js');

const silentLog = { debug() {}, verbose() {}, info() {}, warn() {}, error() {} };

// The running captures, by site and streamer, as the downloads manager reports them.
// A start is recorded, not run. `sessions` holds the captures of `site` (one site per
// test unless a test adds others under "<site>:<id>" in `all`).
function fakeManager(site) {
    const all = new Map();
    const sessions = {
        set: (id, session) => all.set(`${site}:${id}`, session),
        get: (id) => all.get(`${site}:${id}`),
        has: (id) => all.has(`${site}:${id}`),
    };
    const finalized = [];
    const starts = [];
    const urls = new Set();
    return {
        all, sessions, finalized, starts, urls,
        get size() { return all.size; },
        getRecordingId: (id, provider) => all.get(`${provider}:${id}`)?.recordingId ?? null,
        hasStreamer: (id, provider) => all.has(`${provider}:${id}`),
        has: (url) => urls.has(url),
        activeSessions: (provider) => [...all].filter(([key]) => key.startsWith(`${provider}:`))
            .map(([key, session]) => ({ streamerId: key.slice(provider.length + 1), hasMedia: session.hasMedia })),
        getActiveSegmentPaths: () => new Set(),
        async finalizeStreamer(id, reason, provider) {
            if (!all.has(`${provider}:${id}`)) return false;
            finalized.push([id, reason, provider]);
            all.delete(`${provider}:${id}`);
            return true;
        },
        add(url, data, provider) { starts.push({ url, ...data, provider }); return null; },
    };
}

// A site whose lookup answers from `state`: null (unavailable) or who is live.
function fakeSite(siteId, state, overrides = {}) {
    return {
        pollIntervalMs: 1_000,
        mediaFormat: 'ts',
        provider: { providerName: siteId },
        lookups: 0,
        async lookup(targets, running) {
            this.lookups++;
            this.lastRunning = running;
            if (state.unavailable) return null;
            const live = new Map();
            for (const target of targets) {
                const recordingId = state.live?.[target.id];
                if (recordingId) live.set(target.id, {
                    targetId: target.id, alias: target.label, recordingId,
                    masterPlaylistUrl: `https://cdn.example.test/${target.id}/${recordingId}.m3u8`,
                });
            }
            return {
                observedAt: state.now,
                live,
                terminalTargetIds: new Set(targets.map((target) => target.id).filter((id) => !live.has(id))),
            };
        },
        ...overrides,
    };
}

function fixture(siteId, { targets = [{ id: 'a1', label: 'alpha' }], state = { now: 0 }, capture = {} } = {}) {
    const listed = [...targets];
    const manager = fakeManager(siteId);
    const site = fakeSite(siteId, state, capture);
    const loop = new DiscoveryLoop({ id: siteId, label: siteId.toUpperCase(), log: silentLog }, site, {
        getTargets: () => [...listed],
        hasTarget: (id) => listed.some((target) => target.id === id),
    }, manager);
    return { loop, manager, site, listed, state };
}

test('a lookup failure never ends a session, however long it lasts', async () => {
    const f = fixture('site-a', { state: { unavailable: true, now: 0 } });
    f.manager.sessions.set('a1', { recordingId: 'r1', hasMedia: false });
    for (let n = 0; n < 5; n++) {
        f.state.now += 60_000;
        await f.loop.poll();
    }
    assert.equal(f.site.lookups, 5);
    assert.deepEqual(f.manager.finalized, []);
    assert.deepEqual(f.manager.starts, []);
});

test('a terminal target ends its session only after 60 s over two observations', async () => {
    const f = fixture('site-b', { state: { now: 1_000 } });
    f.manager.sessions.set('a1', { recordingId: 'r1', hasMedia: false });
    await f.loop.poll();
    f.state.now = 1_000 + 59_999;
    await f.loop.poll();
    assert.deepEqual(f.manager.finalized, []);
    f.state.now = 1_000 + 60_000;
    await f.loop.poll();
    assert.deepEqual(f.manager.finalized, [['a1', 'offline for 60s without any media', 'site-b']]);
});

test('a terminal target hands its recording to the server only after 60 s', async () => {
    const f = fixture('site-c', { state: { now: 0 } });
    const downloaded = path.join(sandbox, 'downloads', 'site-c', 'downloaded');
    const name = '2026-03-04 050607 alpha';
    const folder = path.join(downloaded, '.active', name);
    await mkdir(folder, { recursive: true });
    const segment = formatSegmentName(0, 'r1', 7);
    await writeFile(path.join(folder, segment), 'media');
    await writeFile(path.join(folder, 'playlist.m3u8'), `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${segment}\n`);

    await f.loop.poll();
    f.state.now = 30_000;
    await f.loop.poll();
    assert.deepEqual(await readdir(path.join(downloaded, '.active')), [name]);
    f.state.now = 60_000;
    await f.loop.poll();
    assert.deepEqual(await readdir(path.join(downloaded, '.active')), []);
    assert.deepEqual(await readdir(path.join(downloaded, '.pending')), [name]);
});

test('a site that opts in has a new recording identity replace the running session, also one without a folder', async () => {
    const f = fixture('site-d', { state: { now: 0, live: { a1: 'r2' } }, capture: { replaceSessionOnNewRecording: true } });
    f.manager.sessions.set('a1', { recordingId: 'r1', hasMedia: false });
    await f.loop.poll();
    assert.deepEqual(f.manager.finalized, [['a1', 'a new stream replaced it', 'site-d']]);
    assert.deepEqual(f.manager.starts.map(({ streamerId, alias, recordingId }) => ({ streamerId, alias, recordingId })),
        [{ streamerId: 'a1', alias: 'alpha', recordingId: 'r2' }]);
});

test('a site that does not opt in keeps the running session and starts no other', async () => {
    const f = fixture('site-d2', { state: { now: 0, live: { a1: 'r2' } } });
    f.manager.sessions.set('a1', { recordingId: 'r1', hasMedia: false });
    await f.loop.poll();
    assert.deepEqual(f.manager.finalized, []);
    assert.deepEqual(f.manager.starts, []);
});

test('the same recording identity keeps the running session', async () => {
    const f = fixture('site-e', { state: { now: 0, live: { a1: 'r1' } } });
    f.manager.sessions.set('a1', { recordingId: 'r1', hasMedia: true });
    await f.loop.poll();
    assert.deepEqual(f.manager.finalized, []);
    assert.deepEqual(f.manager.starts, []);
});

test('a target removed from the list ends its session, even while the lookup fails', async () => {
    const f = fixture('site-f', { state: { unavailable: true, now: 0 } });
    f.manager.sessions.set('a1', { recordingId: 'r1', hasMedia: true });
    await f.loop.poll();
    assert.deepEqual(f.manager.finalized, []);
    f.listed.length = 0;
    await f.loop.poll();
    assert.deepEqual(f.manager.finalized, [['a1', 'removed from the download list', 'site-f']]);
});

test('a target removed while the lookup is in flight does not start', async () => {
    const f = fixture('site-g', { state: { now: 0, live: { a1: 'r1' } } });
    const lookup = f.site.lookup;
    f.site.lookup = async function (...args) {
        const snapshot = await lookup.apply(this, args);
        f.listed.length = 0;
        return snapshot;
    };
    await f.loop.poll();
    assert.deepEqual(f.manager.starts, []);
});

test('a live target starts with the stream the site resolves just before the start', async () => {
    const resolved = [];
    const f = fixture('site-h', {
        targets: [{ id: 'a1', label: 'alpha' }, { id: 'b2', label: 'beta' }],
        state: { now: 0, live: { a1: 'r1', b2: 'r2' } },
        capture: {
            async resolveMaster(live) {
                resolved.push(live.targetId);
                // b2 cannot start now; a1 starts under its current name and identity.
                return live.targetId === 'b2' ? null
                    : { ...live, alias: 'alpha_renamed', recordingId: 'r1b', masterPlaylistUrl: 'https://cdn.example.test/a1/handshake.m3u8' };
            },
        },
    });
    f.manager.sessions.set('c3', { recordingId: 'x', hasMedia: true }); // not listed, ends
    await f.loop.poll();
    assert.deepEqual(resolved, ['a1', 'b2']);
    assert.deepEqual(f.manager.starts.map(({ url, streamerId, alias, recordingId }) => ({ url, streamerId, alias, recordingId })), [
        { url: 'https://cdn.example.test/a1/handshake.m3u8', streamerId: 'a1', alias: 'alpha_renamed', recordingId: 'r1b' },
    ]);
});

test('the lookup sees the identity of the capture running for each target', async () => {
    const f = fixture('site-i', { state: { now: 0 } });
    f.manager.sessions.set('a1', { recordingId: 'r9', hasMedia: true });
    await f.loop.poll();
    assert.equal(f.site.lastRunning.recordingId('a1'), 'r9');
    assert.equal(f.site.lastRunning.recordingId('zz'), null);
});

test('a target in cooldown after a capture without media does not restart until it ends', async (t) => {
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);
    const f = fixture('site-j', { state: { now: 0, live: { a1: 'r1' } } });
    f.loop.cooldown.recordFailure('a1');
    await f.loop.poll();
    assert.deepEqual(f.manager.starts, []);
    now += 20_000;
    await f.loop.poll();
    assert.equal(f.manager.starts.length, 1);
});

test('a recording folder maps to its target by label unless the site maps it', () => {
    const f = fixture('site-k', { targets: [{ id: 'a1', label: 'alpha' }, { id: '', label: 'unresolved' }] });
    assert.equal(f.loop.targetIdForFolderAlias('alpha'), 'a1');
    assert.equal(f.loop.targetIdForFolderAlias('unresolved'), '');
    assert.equal(f.loop.targetIdForFolderAlias('gone'), null);
    const mapped = fixture('site-l', { capture: { targetIdForFolderAlias: (alias, targets) => targets.length === 1 && alias === '42' ? 'a1' : null } });
    assert.equal(mapped.loop.targetIdForFolderAlias('42'), 'a1');
    assert.equal(mapped.loop.targetIdForFolderAlias('alpha'), null);
});

// The loop sleeps through timers/promises: record the waits, and stop at the second.
function recordSleeps(t) {
    const sleeps = [];
    const original = timersPromises.setTimeout;
    timersPromises.setTimeout = (ms) => {
        sleeps.push(ms);
        return sleeps.length >= 2 ? new Promise(() => {}) : Promise.resolve();
    };
    syncBuiltinESMExports();
    t.after(() => {
        timersPromises.setTimeout = original;
        syncBuiltinESMExports();
    });
    return sleeps;
}

async function until(check) {
    for (let n = 0; n < 200 && !check(); n++) await new Promise((resolve) => setImmediate(resolve));
    assert(check(), 'condition not reached');
}

test('the cadence runs from the end of a poll, or from its start when the site asks', async (t) => {
    const sleeps = recordSleeps(t);
    let now = 5_000;
    t.mock.method(Date, 'now', () => now);
    const slow = (extra) => ({ async lookup() { now += 400; return null; }, ...extra });

    const afterPoll = fixture('site-m', { capture: slow({ pollIntervalMs: 1_000 }) });
    afterPoll.loop.activeReconciler.recoverLocalState = async () => {};
    void afterPoll.loop.start();
    await until(() => sleeps.length === 2);
    assert.deepEqual(sleeps, [1_000, 1_000]);

    sleeps.length = 0;
    const fromStart = fixture('site-n', { capture: slow({ pollIntervalMs: 30_000, pollFromStart: true }) });
    fromStart.loop.activeReconciler.recoverLocalState = async () => {};
    void fromStart.loop.start();
    await until(() => sleeps.length === 2);
    assert.deepEqual(sleeps, [29_600, 29_600]);
});

test('a poll that throws is logged in the site\'s words and the next poll still runs', async (t) => {
    const sleeps = recordSleeps(t);
    const errors = [];
    let calls = 0;
    const f = fixture('site-o', { capture: { async lookup() { throw ++calls === 1 ? new Error('site exploded') : 'not an error'; } } });
    f.loop.site.log = { ...silentLog, error: (...args) => errors.push(args) };
    f.loop.activeReconciler.recoverLocalState = async () => {};
    void f.loop.start();
    await until(() => sleeps.length === 2);
    assert.deepEqual(errors, [['Poll error', { error: 'site exploded' }], ['Poll error', { error: undefined }]]);

    sleeps.length = 0;
    const own = fixture('site-o2', { capture: { pollErrorMessage: 'Error processing the channel list', async lookup() { throw new Error('x'); } } });
    own.loop.site.log = { ...silentLog, error: (...args) => errors.push(args) };
    own.loop.activeReconciler.recoverLocalState = async () => {};
    void own.loop.start();
    await until(() => sleeps.length === 2);
    assert.deepEqual(errors.slice(2), [['Error processing the channel list', { error: 'x' }], ['Error processing the channel list', { error: 'x' }]]);
});

test('the same numeric ID live on two sites: each site starts, keeps and ends only its own capture', async () => {
    const manager = fakeManager('site-p');
    const state = { now: 0, live: { 123: 'q1' } };
    const listed = [{ id: '123', label: 'q-123' }];
    const loop = new DiscoveryLoop({ id: 'site-q', label: 'Q', log: silentLog },
        fakeSite('site-q', state, { replaceSessionOnNewRecording: true }),
        { getTargets: () => [...listed], hasTarget: (id) => listed.some((t) => t.id === id) }, manager);
    // site-p captures its own "123" with another identity.
    manager.all.set('site-p:123', { recordingId: 'p1', hasMedia: true });

    await loop.poll();
    assert.deepEqual(manager.finalized, [], "site-q does not replace site-p's capture");
    assert.deepEqual(manager.starts.map(({ streamerId, provider, recordingId }) => ({ streamerId, provider, recordingId })),
        [{ streamerId: '123', provider: 'site-q', recordingId: 'q1' }], 'site-q starts its own capture');

    manager.all.set('site-q:123', { recordingId: 'q1', hasMedia: true });
    listed.length = 0;
    state.now = 120_000;
    await loop.poll();
    assert.deepEqual(manager.finalized, [['123', 'removed from the download list', 'site-q']]);
    assert.ok(manager.all.has('site-p:123'), "site-p's capture runs on");
});

test('captures start in the order the site gives', async () => {
    const f = fixture('site-r', {
        targets: [{ id: 'a1', label: 'alpha' }, { id: 'b2', label: 'beta' }, { id: 'c3', label: 'gamma' }],
        state: { now: 0, live: { a1: 'r1', b2: 'r2', c3: 'r3' } },
    });
    const lookup = f.site.lookup;
    f.site.lookup = async function (...args) {
        return { ...await lookup.apply(this, args), startOrder: ['c3', 'x9', 'a1', 'b2'] };
    };
    await f.loop.poll();
    assert.deepEqual(f.manager.starts.map(({ streamerId }) => streamerId), ['c3', 'a1', 'b2']);
});

test('a live target without an identity is neither live nor terminal, and may still start through resolveMaster', async () => {
    const resolved = [];
    const f = fixture('site-s', {
        targets: [{ id: 'a1', label: 'alpha' }, { id: 'b2', label: 'beta' }],
        state: { now: 0 },
        capture: {
            async lookup(targets) {
                return { observedAt: 0, live: new Map(), terminalTargetIds: new Set(), unidentifiedTargetIds: new Set(targets.map((t) => t.id)) };
            },
            async resolveMaster(live) {
                resolved.push({ ...live });
                return live.targetId === 'a1' ? { ...live, recordingId: 'read-again', masterPlaylistUrl: 'https://cdn.example.test/a1.m3u8' } : null;
            },
        },
    });
    f.manager.sessions.set('b2', { recordingId: 'r', hasMedia: false });
    await f.loop.poll();
    assert.deepEqual(resolved, [{ targetId: 'a1', alias: 'alpha', recordingId: '', masterPlaylistUrl: '' }], 'b2 has a capture already');
    assert.deepEqual(f.manager.starts.map(({ streamerId, recordingId }) => ({ streamerId, recordingId })), [{ streamerId: 'a1', recordingId: 'read-again' }]);
    assert.deepEqual(f.manager.finalized, []);
});

test('a resolved playlist already being captured does not start twice', async () => {
    const f = fixture('site-t', {
        state: { now: 0, live: { a1: 'r1' } },
        capture: { async resolveMaster(live) { return { ...live, masterPlaylistUrl: 'https://cdn.example.test/shared.m3u8' }; } },
    });
    f.manager.urls.add('https://cdn.example.test/shared.m3u8');
    await f.loop.poll();
    assert.deepEqual(f.manager.starts, []);
});
