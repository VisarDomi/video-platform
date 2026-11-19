import assert from 'node:assert/strict';
import test from 'node:test';
import { SimClock } from '../dist/clock.js';
import { LiveEngine } from '../dist/engine/engine.js';
import { MediaLibrary } from '../dist/media/library.js';
import { validateScenario, ScenarioError, parseSeconds } from '../dist/scenario/schema.js';
import { EPOCH, syntheticManifest } from './helpers.mjs';

const library = new MediaLibrary('/nonexistent', [syntheticManifest({ segments: 10, durationS: 1 })]);

function engineFor(channel, { site = 'ts-live', seed = 'seed-1', clockAt = EPOCH, siteExtra = {} } = {}) {
    const siteSpec = { channels: [{ id: site === 'ts-live' ? 'chan-a' : '101', name: 'centre', schedule: { always: true }, ...channel }], ...siteExtra };
    if (site === 'ts-live') siteSpec.accounts = [{ username: 'u', password: 'p', accountId: 'acct-1' }];
    const scenario = validateScenario({ name: 't', seed, epoch: EPOCH, sites: { [site]: siteSpec } });
    const clock = new SimClock({ mode: 'manual', at: clockAt });
    const engine = new LiveEngine(scenario, library, clock, EPOCH);
    const model = engine.siteChannels(site)[0];
    return { engine, clock, model };
}

const at = s => EPOCH + s * 1000;

test('a manual clock stands exactly where it was set, however real time moves while it is built', () => {
    // A real clock that ticks a millisecond on every read: the worst case of
    // two reads straddling a tick, which a loaded machine hits now and then.
    let real = EPOCH + 123_456;
    const ticking = () => real++;
    assert.equal(new SimClock({ mode: 'manual', at: EPOCH }, ticking).now(), EPOCH);
    assert.equal(new SimClock({ mode: 'manual', at: EPOCH }, ticking).now(), EPOCH, 'every time');
    const frozenNow = new SimClock({ mode: 'manual' }, ticking);
    assert.equal(frozenNow.now(), frozenNow.now(), 'manual without "at" freezes one instant');
    const live = new SimClock({ at: EPOCH }, ticking);
    assert.ok(Math.abs(live.now() - EPOCH) <= 2, 'real mode starts at "at" and runs on');
    const restored = SimClock.restore(new SimClock({ mode: 'manual', at: EPOCH + 5 }, ticking).snapshot(), ticking);
    assert.equal(restored.now(), EPOCH + 5);
});

test('the live window slides with the clock', () => {
    const { model, clock } = engineFor({ startPosition: 0, edges: [{ id: 'a', firstSequence: 100 }] });
    const edge = model.edge('a');
    const session = model.sessionAt(clock.now());
    assert.equal(session.index, 0);
    // 3.5 s in: segments 0-2 are complete.
    clock.set(at(3.5));
    let w = model.window(session, edge, clock.now());
    assert.deepEqual(w.entries.map(e => e.k), [0, 1, 2]);
    assert.equal(w.mediaSequence, 100);
    // 10 s in: the six newest of 0-9.
    clock.advance(6500);
    w = model.window(session, edge, clock.now());
    assert.deepEqual(w.entries.map(e => e.seq), [104, 105, 106, 107, 108, 109]);
    assert.equal(w.mediaSequence, 104);
    assert.equal(w.ended, false);
    // The source has 10 segments: k = 12 is source segment 2 on its second pass.
    w = model.window(session, edge, at(13));
    assert.deepEqual(w.entries.map(e => [e.k, e.srcIndex, e.loop]).at(-1), [12, 2, 1]);
});

test('program date-times are continuous, across source loops too', () => {
    const { model } = engineFor({ startPosition: 7, window: 10 });
    const session = model.sessionAt(EPOCH);
    const w = model.window(session, model.edges[0], at(20));
    assert.equal(w.entries.length, 10);
    assert.ok(w.entries.some(e => e.loop === 1) && w.entries.some(e => e.loop === 2), 'the window spans a loop boundary');
    for (let i = 1; i < w.entries.length; i++) {
        const prev = w.entries[i - 1], cur = w.entries[i];
        assert.equal(cur.pdtMs - prev.pdtMs, prev.durationS * 1000);
        assert.equal(cur.seq, prev.seq + 1);
    }
    assert.equal(w.entries[0].pdtMs, model.segmentStartMs(session, w.entries[0].k));
});

test('edges number independently, lag, and stamp slightly skewed times', () => {
    const { model } = engineFor({ edges: [{ id: 'a' }, { id: 'b', lagMs: 400, pdtSkewMs: 25 }, { id: 'c' }] }, { site: 'fmp4-live' });
    const session = model.sessionAt(EPOCH);
    const [a, b, c] = model.edges;
    assert.equal(a.lagMs, 0);
    assert.ok(c.lagMs >= 150 && c.lagMs <= 900, 'unspecified lag is seeded');
    const t = at(30) + 100; // just after a 2 s segment completed at the origin
    const wa = model.window(session, a, t), wb = model.window(session, b, t);
    assert.equal(wa.entries.at(-1).k, wb.entries.at(-1).k + 1, 'the lagging edge has not listed the newest segment yet');
    const shared = wb.entries.at(-1).k;
    const ea = wa.entries.find(e => e.k === shared), eb = wb.entries.at(-1);
    assert.equal(eb.pdtMs - ea.pdtMs, 25);
    assert.equal(eb.srcIndex, ea.srcIndex, 'same media on both edges');
    assert.notEqual(eb.seq - ea.seq, 0, 'independent numbering');
    const wb2 = model.window(session, b, at(30) + 500);
    assert.equal(wb2.entries.at(-1).k, wa.entries.at(-1).k);
});

test('the same seed and time give the same playlists; another seed does not', () => {
    const one = engineFor({}, { seed: 'x' }).model, two = engineFor({}, { seed: 'x' }).model, three = engineFor({}, { seed: 'y' }).model;
    const w = m => { const s = m.sessionAt(at(50)); return m.window(s, m.edges[0], at(50)); };
    assert.deepEqual(w(one).entries, w(two).entries);
    assert.equal(w(one).session.key, w(two).session.key);
    assert.notEqual(w(one).session.key, w(three).session.key);
});

test('a cycle schedule goes online and offline with a new identity per session', () => {
    const { model } = engineFor({ schedule: { cycle: { periodS: 60, onlineS: 40 } } });
    const s0 = model.sessionAt(at(10)), s1 = model.sessionAt(at(70));
    assert.equal(s0.index, 0);
    assert.equal(s1.index, 1);
    assert.equal(model.sessionAt(at(45)), null);
    assert.notEqual(s0.key, s1.key);
    assert.equal(model.latestSession(at(45)).key, s0.key);
    assert.equal(model.sessionByKey(s0.key, at(100)).index, 0);
});

test('a provider skip stalls the window, then restarts it small after a hole', () => {
    const { model } = engineFor({ startPosition: 0, edges: [{ id: 'a', firstSequence: 0 }], faults: [{ type: 'skip', at: 10, count: 3 }] });
    const s = model.sessionAt(EPOCH), e = model.edges[0];
    assert.deepEqual(model.window(s, e, at(12.5)).entries.map(x => x.seq), [4, 5, 6, 7, 8, 9], 'stalled: nothing new');
    assert.deepEqual(model.window(s, e, at(14.5)).entries.map(x => x.seq), [13], 'restarted small after the hole');
    assert.equal(model.segmentAvailability(s, e, 11, at(20)), 'never');
    assert.equal(model.segmentAvailability(s, e, 13, at(20)), 'ok');
});

test('a numbering restart starts over from the given value and drops the old window', () => {
    const { model } = engineFor({ startPosition: 0, edges: [{ id: 'a', firstSequence: 1100 }], faults: [{ type: 'restart', at: 20, value: 1 }] });
    const s = model.sessionAt(EPOCH), e = model.edges[0];
    assert.deepEqual(model.window(s, e, at(20.5)).entries.map(x => x.seq), [1114, 1115, 1116, 1117, 1118, 1119]);
    assert.deepEqual(model.window(s, e, at(22.5)).entries.map(x => x.seq), [1, 2]);
});

test('stale playlists freeze, or lag by a fixed amount', () => {
    const { model } = engineFor({ startPosition: 0, faults: [
        { type: 'stalePlaylist', at: 10, until: 15 },
        { type: 'stalePlaylist', at: 30, until: 40, staleByS: 4 },
    ] });
    const s = model.sessionAt(EPOCH), e = model.edges[0];
    const frozen = model.window(s, e, at(14));
    assert.equal(frozen.staleAt, at(10));
    assert.equal(frozen.entries.at(-1).k, 9, 'segment 9 completed at exactly 10 s');
    assert.equal(model.window(s, e, at(15)).entries.at(-1).k, 14);
    assert.equal(model.window(s, e, at(15)).staleAt, null);
    assert.equal(model.window(s, e, at(35)).entries.at(-1).k, 30);
});

test('codec changes and damage windows change what is served for the segments they cover', () => {
    const { model } = engineFor({ startPosition: 0, faults: [
        { type: 'codecChange', at: 5, until: 8 },
        { type: 'damage', at: 10, until: 14, kind: 'single-frame', every: 2 },
    ] });
    const s = model.sessionAt(EPOCH), e = model.edges[0];
    const w = model.window(s, e, at(15), 0);
    // Window covers k 9-14 at 15 s; codec change covers 5-7, damage 10 and 12.
    assert.deepEqual(w.entries.map(x => x.damage), [null, 'single-frame', null, 'single-frame', null, null]);
    const early = model.window(s, e, at(9), 0);
    assert.deepEqual(early.entries.map(x => x.rendition), [0, 0, 1, 1, 1, 0]);
});

test('a stream end lists ENDLIST for the grace period, then the playlist is gone', () => {
    const { model } = engineFor({ startPosition: 0, endlistS: 5, faults: [{ type: 'streamEnd', at: 30 }] });
    const s = model.sessionAt(EPOCH), e = model.edges[0];
    assert.equal(s.endMs, at(30));
    assert.equal(model.window(s, e, at(29)).ended, false);
    const ended = model.window(s, e, at(31));
    assert.equal(ended.ended, true);
    assert.equal(ended.gone, false);
    assert.equal(ended.entries.at(-1).k, 29);
    assert.equal(model.window(s, e, at(35)).gone, true);
    assert.equal(model.sessionAt(at(31)), null);
    assert.equal(model.segmentAvailability(s, e, 30, at(40)), 'never');
});

test('request-time faults: windows, edges, and a deterministic ratio', () => {
    const { model } = engineFor({ edges: [{ id: 'a' }, { id: 'b' }], faults: [
        { type: 'playlistStatus', at: 10, until: 20, status: 401 },
        { type: 'edgeOutage', at: 0, until: 100, edge: 'b', status: 403 },
        { type: 'segmentStatus', at: 0, until: 1000, status: 429, ratio: 0.5 },
    ] });
    const s = model.sessionAt(EPOCH);
    assert.equal(model.active(s, 'playlistStatus', at(15), 'a').length, 1);
    assert.equal(model.active(s, 'playlistStatus', at(20), 'a').length, 0);
    assert.equal(model.active(s, 'edgeOutage', at(50), 'a').length, 0);
    assert.equal(model.active(s, 'edgeOutage', at(50), 'b').length, 1);
    const hits = Array.from({ length: 400 }, (_, i) => model.active(s, 'segmentStatus', at(i)).length).reduce((a, b) => a + b, 0);
    assert.ok(hits > 150 && hits < 250, `about half the seconds fail, got ${hits}/400`);
    assert.equal(model.active(s, 'segmentStatus', at(7.2)).length, model.active(s, 'segmentStatus', at(7.9)).length, 'stable within a second');
});

test('session-scoped faults repeat in every session', () => {
    const { model } = engineFor({ schedule: { cycle: { periodS: 100, onlineS: 60 } }, faults: [{ type: 'streamEnd', at: 20, scope: 'session' }] });
    assert.equal(model.sessionAt(at(10)).endMs, at(20));
    assert.equal(model.sessionAt(at(110)).endMs, at(120));
});

test('renames apply from their time on', () => {
    const { model } = engineFor({ renames: [{ at: 60, name: 'court-2' }, { at: '2m', name: 'court-3' }] });
    assert.equal(model.nameAt(at(10)), 'centre');
    assert.equal(model.nameAt(at(90)), 'court-2');
    assert.deepEqual(model.namesAt(at(200)), ['court-3', 'court-2', 'centre']);
});

test('scenario validation rejects unknown keys, bad types and misplaced faults, naming the path', () => {
    const bad = {
        name: 'x', seed: 's', sites: {
            'ts-live': { accounts: [], channels: [{ id: 'a', name: 'n', schedule: { always: true }, colour: 'red',
                faults: [{ type: 'playlistStatus', at: 5, until: 1, status: 418, extra: 1 }, { type: 'showState', at: 0, until: 5, state: 'group' }] }] },
            'other-site': {},
        },
    };
    assert.throws(() => validateScenario(bad), err => {
        assert.ok(err instanceof ScenarioError);
        const text = err.problems.join('\n');
        assert.match(text, /scenario\.sites: unknown key "other-site"/);
        assert.match(text, /channels\[0\]: unknown key "colour"/);
        assert.match(text, /faults\[0\]: unknown key "extra"/);
        assert.match(text, /faults\[0\]\.status: expected one of/);
        assert.match(text, /faults\[0\]: "until" must be after "at"/);
        assert.match(text, /fault type "showState" is not one of/);
        return true;
    });
    assert.throws(() => validateScenario({ name: 'x', seed: 's', sites: { 'fmp4-live': { channels: [
        { id: '7', name: 'n', schedule: { always: true }, faults: [{ type: 'edgeOutage', at: 0, until: 1, edge: 'zz', status: 403 }] }] } } }),
        /unknown edge "zz"/);
    assert.equal(parseSeconds('1h30m'), 5400);
    assert.equal(parseSeconds('90s'), 90);
    assert.equal(parseSeconds('soon'), undefined);
    const ok = validateScenario({ name: 'x', seed: 's', epoch: '2026-06-01T12:00:00Z', sites: { 'ladder-live': { channels: [] } } });
    assert.equal(ok.epoch, EPOCH);
    assert.equal(ok.segmentRetentionS, 120);
});
