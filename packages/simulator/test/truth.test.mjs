import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { SimClock } from '../dist/clock.js';
import { startSimulator } from '../dist/serve.js';
import { TruthIndex } from '../dist/truth/query.js';
import { EPOCH, sharedLibrary, segmentsOf, tempDir, variantsOf } from './helpers.mjs';

test('the ground-truth log records what each edge published, and every response', async (t) => {
    const media = await sharedLibrary();
    const dir = tempDir(t);
    const clock = new SimClock({ mode: 'manual', at: EPOCH + 20_000 });
    const sim = await startSimulator({
        scenario: { name: 'truth', seed: 'truth-seed', epoch: EPOCH, segmentRetentionS: 30, sites: { 'fmp4-live': { channels: [
            { id: '77', name: 'tie-break', startPosition: 0, schedule: { sessions: [{ start: 0, end: 60 }] },
              edges: [{ id: 'a', firstSequence: 500 }, { id: 'b', firstSequence: 20, lagMs: 400 }],
              faults: [{ type: 'skip', at: 30, count: 1, edge: 'a' }, { type: 'edgeOutage', at: 25, until: 26, edge: 'b', status: 503 }] },
        ] } } },
        media: media.library, clock, autoPublish: false, truthFile: path.join(dir, 'truth.jsonl'),
    });
    t.after(() => sim.close());
    const base = sim.urls['fmp4-live'];
    const cam = await (await fetch(base + '/api/channels/77/stream')).json();
    const url = new URL(variantsOf(await (await fetch(cam.stream.masterUrls.a)).text())[0].uri, cam.stream.masterUrls.a);
    const served = segmentsOf(await (await fetch(url)).text());
    const seg = await fetch(new URL(served.segments.at(-1).uri, url));
    const bytes = Buffer.from(await seg.arrayBuffer());
    clock.set(EPOCH + 25_500);
    assert.equal((await fetch(cam.stream.masterUrls.b)).status, 503);
    // Publish as time passes, through the end of the session.
    for (let s = 21; s <= 80; s++) clock.set(EPOCH + s * 1000);
    sim.sim.truth.flush();

    const truth = TruthIndex.fromFile(sim.truthFile);
    const filter = { site: 'fmp4-live', channel: '77', edge: 'a', tier: 'fmp4' };
    // What playlists on edge a listed at 20 s matches what was served then.
    assert.deepEqual(truth.listedAt(filter, EPOCH + 20_000).map(s => s.seq), served.segments.map(s => s.seq));
    const last = truth.listedAt(filter, EPOCH + 20_000).at(-1);
    assert.equal(last.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(last.pdt, served.segments.at(-1).pdt);
    // Availability windows: listed from publication until the window moves on.
    const all = truth.available(filter);
    for (const s of all) {
        assert.ok(s.listed.from < s.listed.until);
        assert.ok(s.fetchable.from >= EPOCH + 20_000, 'nothing counts as available before the server started');
        if (s.fetchable.from > EPOCH + 20_000) assert.equal(s.fetchable.until - s.fetchable.from, 30_000, 'retention');
    }
    // The provider skip on edge a is a hole the checker must not blame on a client.
    const session = truth.sessions({ site: 'fmp4-live', channel: '77' })[0];
    assert.equal(truth.sequenceHoles({ ...filter, session: session.session }).length, 1);
    // Edge b numbers on its own and lags.
    const b = truth.available({ ...filter, edge: 'b' });
    const aByK = new Map(all.map(s => [s.k, s]));
    const pair = b.find(s => aByK.has(s.k) && aByK.get(s.k).listed.from > EPOCH + 21_000);
    assert.equal(pair.listed.from - aByK.get(pair.k).listed.from, 400);
    assert.notEqual(pair.seq, aByK.get(pair.k).seq);
    // Both tiers are recorded.
    assert.ok(truth.available({ site: 'fmp4-live', tier: 'fmp4-alt' }).length > 0);
    // The session ended at 60 s: nothing is listed after its ENDLIST grace.
    assert.equal(truth.listedAt(filter, EPOCH + 70_000).length, 0);
    // Responses, statuses included.
    const statuses = truth.responses({ site: 'fmp4-live' }).map(r => `${r.kind}:${r.status}`);
    assert.ok(statuses.includes('master:503') && statuses.includes('media:200') && statuses.includes('segment:200') && statuses.includes('api:200'));
    const segmentResponse = truth.responses({ site: 'fmp4-live', kind: 'segment' })[0];
    assert.equal(segmentResponse.sha256, last.sha256);
    assert.equal(segmentResponse.seq, last.seq);
});

test('records before a scenario switch stop at the switch', async (t) => {
    const media = await sharedLibrary();
    const clock = new SimClock({ mode: 'manual', at: EPOCH + 20_000 });
    const scenario = name => ({ name, seed: name, epoch: EPOCH, sites: { 'ladder-live': { channels: [{ id: '5', name: 'c', schedule: { always: true } }] } } });
    const sim = await startSimulator({ scenario: scenario('one'), media: media.library, clock, autoPublish: false, memoryTruth: true });
    t.after(() => sim.close());
    clock.set(EPOCH + 30_000);
    sim.sim.load((await import('../dist/scenario/schema.js')).validateScenario(scenario('two')), { reason: 'switch' });
    clock.set(EPOCH + 40_000);
    const truth = new TruthIndex(sim.memory.records);
    const sessions = truth.sessions({ site: 'ladder-live' });
    assert.equal(sessions.length, 2, 'a new seed gives a new session identity');
    const old = truth.available({ site: 'ladder-live', session: sessions[0].session });
    assert.ok(old.length > 0);
    assert.ok(old.every(s => s.listed.until <= EPOCH + 30_000));
    assert.ok(truth.available({ site: 'ladder-live', session: sessions[1].session }).length > 0);
});

test('the log rotates by size and by time; the index reads the rotated set as one log', async (t) => {
    const { truthFiles } = await import('../dist/truth/log.js');
    const { readFileSync, statSync } = await import('node:fs');
    const media = await sharedLibrary();
    const scenario = { name: 'rotate', seed: 'rotate', epoch: EPOCH, sites: { 'fmp4-live': { channels: [
        { id: '9', name: 'rot', startPosition: 0, schedule: { sessions: [{ start: 0, end: 40 }, { start: 50 }] }, edges: [{ id: 'a' }, { id: 'b', lagMs: 300 }] },
    ] } } };
    const dir = tempDir(t);
    const file = path.join(dir, 'truth.jsonl');
    const clock = new SimClock({ mode: 'manual', at: EPOCH + 5_000 });
    const sim = await startSimulator({ scenario, media: media.library, clock, autoPublish: false, memoryTruth: true, truthFile: file, truthRotation: { maxBytes: 16_000 } });
    t.after(() => sim.close());
    for (let s = 6; s <= 80; s++) clock.set(EPOCH + s * 1000);
    sim.sim.truth.flush();
    const files = truthFiles(file);
    assert.ok(files.length >= 4, `rotated into ${files.length} files`);
    assert.equal(files.at(-1), file);
    for (const f of files.slice(0, -1)) assert.ok(statSync(f).size <= 16_000, 'each file stays under the limit');
    for (const f of files.slice(1)) {
        const first = JSON.parse(readFileSync(f, 'utf8').split('\n')[0]);
        assert.equal(first.type, 'scenario');
        assert.equal(first.reason, 'continue', 'a rotated-in file starts with the scenario in force');
    }
    const fromFiles = TruthIndex.fromFile(dir);
    const fromMemory = new TruthIndex(sim.memory.records);
    const filter = { site: 'fmp4-live', channel: '9' };
    assert.deepEqual(fromFiles.available(filter), fromMemory.available(filter));
    assert.deepEqual(fromFiles.sessions(filter).map(s => s.session), fromMemory.sessions(filter).map(s => s.session));
    assert.equal(fromFiles.sessions(filter).length, 2, 'sessions logged again after a rotation are read once');
    assert.equal(fromFiles.scenarios.length, 1, 'continuation records start no new period');
    assert.deepEqual(fromFiles.listedAt({ ...filter, edge: 'a', tier: 'fmp4' }, EPOCH + 30_000).map(s => s.seq),
        fromMemory.listedAt({ ...filter, edge: 'a', tier: 'fmp4' }, EPOCH + 30_000).map(s => s.seq));
});

test('time-based rotation, and a pruned set still reads on its own', async (t) => {
    const { truthFiles } = await import('../dist/truth/log.js');
    const media = await sharedLibrary();
    const scenario = { name: 'rotate-time', seed: 'rotate-time', epoch: EPOCH, sites: { 'ladder-live': { channels: [{ id: '4', name: 'c', schedule: { always: true } }] } } };
    const dir = tempDir(t);
    const file = path.join(dir, 'truth.jsonl');
    const clock = new SimClock({ mode: 'manual', at: EPOCH + 5_000 });
    const sim = await startSimulator({ scenario, media: media.library, clock, autoPublish: false, truthFile: file, truthRotation: { maxAgeMs: 10_000, keep: 2 } });
    t.after(() => sim.close());
    for (let s = 6; s <= 45; s++) clock.set(EPOCH + s * 1000);
    sim.sim.truth.flush();
    const files = truthFiles(file);
    assert.equal(files.length, 3, 'two rotated files kept, plus the current one');
    assert.match(path.basename(files[0]), /^truth\.\d{6}\.jsonl$/);
    const truth = TruthIndex.fromFile(file);
    assert.equal(truth.scenarios[0].reason, 'continue', 'the head was pruned: the continuation names the scenario');
    assert.equal(truth.sessions({ site: 'ladder-live' }).length, 1, 'the live session was logged again in a kept file');
    assert.ok(truth.listedAt({ site: 'ladder-live', channel: '4' }, EPOCH + 44_000).length > 0, 'the current window is in the kept files');
    const { parseSize } = await import('../dist/serve.js');
    assert.deepEqual(['500', '64K', '100M', '2G', '1.5KiB'].map(parseSize), [500, 65536, 104857600, 2147483648, 1536]);
});
