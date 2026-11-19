import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { startSimulator } from '../dist/serve.js';
import { peekClaims } from '../dist/sites/tokens.js';
import { readTruthFile } from '../dist/truth/query.js';
import { CookieClient, EPOCH, sharedLibrary, tempDir } from './helpers.mjs';

const tsScenario = (name, channels) => ({
    name, seed: 'control-seed', epoch: EPOCH,
    sites: { 'ts-live': { accounts: [{ username: 'viewer', password: 'pw', accountId: 'acct-1' }], channels } },
});
const ALWAYS = [{ id: 'chan-1', name: 'court-one', schedule: { always: true } }];
const NOBODY = [{ id: 'chan-1', name: 'court-one', schedule: { sessions: [{ start: 100000 }] } }];
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('control API: state, clock moves, scenario switch and validation errors', async (t) => {
    const media = await sharedLibrary();
    const sim = await startSimulator({ scenario: tsScenario('first', ALWAYS), media: media.library, clockMode: 'manual', autoPublish: false, memoryTruth: true });
    t.after(() => sim.close());
    const control = sim.urls.control;
    let state = await (await fetch(control + '/state')).json();
    assert.equal(state.scenario.name, 'first');
    assert.equal(state.clock.mode, 'manual');
    assert.equal(state.sites['ts-live'].url, sim.urls['ts-live']);

    await post(control + '/clock/set', { at: '2026-06-01T12:01:00Z' });
    let clock = await (await post(control + '/clock/advance', { s: 30 })).json();
    assert.equal(clock.iso, '2026-06-01T12:01:30.000Z');
    state = await (await fetch(control + '/state')).json();
    const channel = state.sites['ts-live'].channels[0];
    assert.equal(channel.online, true);
    assert.match(channel.session.recordingId, /^\d+$/);
    assert.equal(channel.edges[0].segments, 6);
    assert.equal((await post(control + '/clock/advance', { ms: -5 })).status, 400);

    const bad = await post(control + '/scenario', { name: 'x', seed: 's', sites: { 'ts-live': { channels: [], accounts: [], typo: 1 } } });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).problems.join('\n'), /unknown key "typo"/);

    const switched = await (await post(control + '/scenario', tsScenario('second', NOBODY))).json();
    assert.equal(switched.scenario.name, 'second');
    assert.equal(switched.sites['ts-live'].channels[0].online, false);
    const records = sim.memory.records.filter(r => r.type === 'scenario').map(r => [r.name, r.reason]);
    assert.deepEqual(records, [['first', 'start'], ['second', 'switch']]);
    clock = await (await post(control + '/clock/mode', { mode: 'real' })).json();
    assert.equal(clock.mode, 'real');
});

test('with a state directory a restart keeps the scenario, epoch, clock and tokens', async (t) => {
    const media = await sharedLibrary();
    const dir = tempDir(t);
    const file = path.join(dir, 'scenario.json');
    writeFileSync(file, JSON.stringify({ ...tsScenario('on-disk', ALWAYS), epoch: null }));
    const stateDir = path.join(dir, 'state');
    const first = await startSimulator({ scenario: file, media: media.cache, stateDir, clockMode: 'manual' });
    let firstOpen = true;
    t.after(() => firstOpen && first.close());
    await post(first.urls.control + '/clock/advance', { s: 42 });
    const client = new CookieClient(first.urls['ts-live']);
    await client.fetch('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=viewer&password=pw' });
    const claims = peekClaims(client.cookie('refresh_token'));
    assert.equal((await client.json('/api/session/refresh', { accountId: claims.sub, sessionId: claims.sid })).status, 200);
    const before = await (await fetch(first.urls.control + '/state')).json();
    await first.close();
    firstOpen = false;

    const second = await startSimulator({ scenario: file, media: media.cache, stateDir });
    t.after(() => second.close());
    const after = await (await fetch(second.urls.control + '/state')).json();
    assert.equal(after.scenario.epochMs, before.scenario.epochMs, 'same timeline');
    assert.equal(after.clock.now, before.clock.now, 'the manual clock did not move while down');
    assert.equal(after.sites['ts-live'].channels[0].session.recordingId, before.sites['ts-live'].channels[0].session.recordingId);
    // The rotated refresh token is still the current one after the restart.
    const again = new CookieClient(second.urls['ts-live']);
    again.jar = new Map(client.jar);
    assert.equal((await again.json('/api/session/refresh', { accountId: claims.sub, sessionId: claims.sid })).status, 200);

    // The truth log spans both runs; a torn last line (a power cut) is skipped.
    const truthFile = path.join(stateDir, 'truth.jsonl');
    second.sim.truth.flush?.();
    appendFileSync(truthFile, '{"type":"publish","t":12');
    const records = readTruthFile(truthFile);
    assert.deepEqual(records.filter(r => r.type === 'scenario').map(r => r.reason), ['start', 'start']);
    assert.ok(records.some(r => r.type === 'event' && r.event === 'refresh'));
});

test('the CLI serves a scenario file and stops cleanly', async (t) => {
    const media = await sharedLibrary();
    const dir = tempDir(t);
    const file = path.join(dir, 'scenario.json');
    writeFileSync(file, JSON.stringify(tsScenario('cli', ALWAYS)));
    const child = spawn(process.execPath, ['dist/cli.js', 'serve', '--scenario', file, '--media', media.cache, '--state', path.join(dir, 'state'),
        '--ports', 'control=0,ts-live=0,ladder-live=0,fmp4-live=0', '--clock', 'manual'], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill('SIGKILL'));
    const line = await new Promise((resolve, reject) => {
        createInterface({ input: child.stdout }).once('line', resolve);
        child.once('exit', code => reject(new Error(`exited ${code}`)));
    });
    const listening = JSON.parse(line);
    assert.equal(listening.event, 'listening');
    const state = await (await fetch(listening.control + '/state')).json();
    assert.equal(state.scenario.name, 'cli');
    assert.equal((await fetch(listening['fmp4-live'] + '/api/channels/status?ids=1')).status, 404, 'a site outside the scenario answers 404');
    const exit = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    assert.equal(await exit, 0);
    const usage = spawn(process.execPath, ['dist/cli.js', 'serve'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    usage.stderr.on('data', d => { err += d; });
    assert.equal(await new Promise(resolve => usage.once('exit', resolve)), 1);
    assert.match(err, /--scenario/);
});

test('the shipped demo scenario is valid and serves all three sites', async (t) => {
    const { validateScenario } = await import('../dist/scenario/schema.js');
    const demo = validateScenario(JSON.parse(readFileSync(new URL('../scenarios/demo.json', import.meta.url), 'utf8')));
    assert.deepEqual(Object.keys(demo.sites).sort(), ['fmp4-live', 'ladder-live', 'ts-live']);
    const media = await sharedLibrary();
    const sim = await startSimulator({ scenario: demo, media: media.library, clockMode: 'manual', autoPublish: false });
    t.after(() => sim.close());
    const state = await (await fetch(sim.urls.control + '/state')).json();
    assert.equal(state.sites['ladder-live'].channels.find(c => c.id === '1002').online, true);
    assert.equal((await fetch(sim.urls['fmp4-live'] + '/api/channels/status?ids=502')).status, 200);
});

test('TLS: the sites serve HTTPS from a given certificate', async (t) => {
    const { execFileSync } = await import('node:child_process');
    const https = await import('node:https');
    const dir = tempDir(t);
    const cert = path.join(dir, 'cert.pem'), key = path.join(dir, 'key.pem');
    try {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
            '-days', '1', '-keyout', key, '-out', cert], { stdio: 'ignore' });
    } catch {
        t.skip('openssl not available');
        return;
    }
    const media = await sharedLibrary();
    const sim = await startSimulator({ scenario: tsScenario('tls', ALWAYS), media: media.library, clockMode: 'manual', autoPublish: false, tls: { cert, key } });
    t.after(() => sim.close());
    assert.match(sim.urls['ts-live'], /^https:/);
    const body = await new Promise((resolve, reject) => {
        https.get(sim.urls['ts-live'] + '/login', { ca: readFileSync(cert) }, res => {
            let data = '';
            res.on('data', d => { data += d; });
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
    assert.match(body, /Sign in/);
});
