// api-host against the simulator, in process: ephemeral ports on 127.0.0.1, a manual
// clock, a tiny generated source for the simulator's library and a short full-HD artifact
// to upload (ffmpeg under nice). Every address comes from the config, as in the sites file.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HumanActionRequiredError, MetadataRejectedError, ProviderSessionLostError, SDK_VERSION, UploadTransportError } from 'sdk';
import { MediaLibrary, SimClock, prepAll, startSimulator } from 'simulator';
import { clientRefOf, destination, readConfig } from '../dist/index.js';

const EPOCH = Date.parse('2026-06-01T12:00:00.000Z');
const CHUNK = 256 * 1024;

function makeVideo(file, size, seconds) {
    execFileSync('nice', ['-n', '19', 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=25`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-threads', '2', '-c:a', 'aac', '-b:a', '48k', file]);
}

let fixtures = null;
// One library and one artifact (a little over 1 MiB: several chunks) per test process.
function media() {
    fixtures ??= (async () => {
        const root = mkdtempSync(path.join(os.tmpdir(), 'api-host-plugin-'));
        process.on('exit', () => rmSync(root, { recursive: true, force: true }));
        mkdirSync(path.join(root, 'in'));
        makeVideo(path.join(root, 'in', 'Practice.mkv'), '320x180', 2);
        await prepAll({ input: path.join(root, 'in'), out: path.join(root, 'cache') });
        const artifact = path.join(root, 'match.mp4');
        makeVideo(artifact, '1920x1080', 2);
        return { library: MediaLibrary.load(path.join(root, 'cache')), artifact };
    })();
    return fixtures;
}

async function start(t, extra = {}, { at = EPOCH + 10_000 } = {}) {
    const { library, artifact } = await media();
    const clock = new SimClock({ mode: 'manual', at });
    const sim = await startSimulator({
        scenario: { name: 'api-host plug-in', seed: 'api-host-plugin', epoch: EPOCH, sites: { 'api-host': {
            accounts: [{ username: 'coach', password: 'pw' }], clients: [{ clientId: 'pipeline', clientSecret: 'client-secret' }],
            rotateRefreshTokens: true, processingS: 60, bannedWords: [{ word: 'forbidden' }], ...extra,
        } } },
        media: library, clock, autoPublish: false, memoryTruth: true, host: '127.0.0.1',
    });
    t.after(() => sim.close());
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'api-host-state-'));
    t.after(() => rmSync(stateDir, { recursive: true, force: true }));
    const stop = new AbortController();
    t.after(() => stop.abort());
    const make = (config = {}) => destination.createDestination({
        config: { baseUrl: sim.urls['api-host'], clientId: 'pipeline', clientSecret: 'client-secret', chunkBytes: CHUNK, retryDelayMs: 0, ...config }, stateDir,
        browser: { executablePath: '/unused', profilePath: '/unused' },
        credentials: () => ({ email: 'coach', password: 'pw' }), stopSignal: stop.signal,
    });
    const events = (name) => sim.memory.records.filter((r) => r.type === 'event' && r.site === 'api-host' && r.event === name);
    return { sim, clock, artifact, stateDir, make, events };
}

function request(artifact, identity, extra = {}) {
    const progress = [], evidence = [];
    return {
        progress, evidence,
        recordingId: identity, uploadIdentity: identity, artifactPath: artifact, sizeBytes: statSync(artifact).size,
        title: `Final set [${identity}]`, description: 'Centre court, full match.', tags: ['tennis', 'final'], visibility: 'public',
        onProgress: (phase, bytes) => { progress.push([phase, bytes]); },
        onEvidence: (item) => { evidence.push(item); },
        ...extra,
    };
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const stored = (stateDir) => JSON.parse(readFileSync(path.join(stateDir, 'session.json'), 'utf8'));
// What the host holds for a video (the API's own view).
const video = async (sim, host, id) => host.withSession(async () => {
    const answer = await fetch(`${sim.urls['api-host']}/v1/videos/${id}`, { headers: { authorization: `Bearer ${await host.tokens.bearer()}` } });
    return answer.json();
});

test('the plug-in declares the SDK version and reads its config', () => {
    assert.equal(destination.sdkVersion, SDK_VERSION);
    assert.equal(destination.id, 'api-host');
    assert.equal(destination.creationBoundary, 'transfer_start');
    const config = readConfig({ baseUrl: 'http://127.0.0.1:1/', clientId: 'c', clientSecret: 's' });
    assert.equal(config.baseUrl, 'http://127.0.0.1:1');
    assert.equal(config.chunkBytes, 8 * 1024 * 1024);
    assert.equal(config.allowPasswordLogin, true);
    for (const raw of [{}, { baseUrl: 'http://x' }, { baseUrl: 'http://x', clientId: 'c', clientSecret: 's', chunkBytes: 1000 },
        { baseUrl: 'http://x', clientId: 'c', clientSecret: 's', categoryId: 'music' }]) {
        assert.throws(() => readConfig(raw), /api-host: config\./, JSON.stringify(raw));
    }
    assert.equal(clientRefOf({ recordingId: 'r', uploadIdentity: 'i' }), clientRefOf({ recordingId: 'r', uploadIdentity: 'i' }));
    assert.notEqual(clientRefOf({ recordingId: 'r', uploadIdentity: 'i' }), clientRefOf({ recordingId: 'r2', uploadIdentity: 'i' }));
});

test('upload signs in, creates the video, sends every byte; verification waits for processing', async (t) => {
    const { sim, clock, artifact, stateDir, make, events } = await start(t);
    const host = make();
    assert.equal((await host.session.check()).loggedIn, false, 'no session yet');
    const job = request(artifact, '2026-06-01 120000 court-one');
    const outcome = await host.upload(job);
    assert.equal(outcome.kind, 'uploaded');
    const { receipt } = outcome;
    assert.equal(events('login').length, 1, 'one password login');
    assert.equal(statSync(path.join(stateDir, 'session.json')).mode & 0o777, 0o600);
    assert.deepEqual([...new Set(job.progress.map(([phase]) => phase))], ['file_uploading', 'file_uploaded']);
    assert.equal(job.progress.filter(([phase, bytes]) => phase === 'file_uploading' && bytes > 0).length, Math.ceil(job.sizeBytes / CHUNK), 'one note per request');
    assert.equal(receipt.transmittedBytes, job.sizeBytes, 'nothing sent twice');
    assert.deepEqual(job.evidence.map((e) => e.stage), ['remote_created', 'file_transfer_complete']);
    assert.equal(events('video-created')[0].clientRef, clientRefOf(job));
    const held = await video(sim, host, receipt.submittedVideoId);
    assert.equal(held.fileDetails.sha256, sha256(artifact), 'the host holds the artifact, byte for byte');

    const check = await host.session.check();
    assert.equal(check.loggedIn, true);
    assert.match(check.fingerprint, /^[0-9a-f]{12}$/);
    assert.ok(check.passwordLoginAt);

    const processing = await host.withSession((s) => s.probe(receipt.submittedVideoId));
    assert.equal(processing.outcome, 'not_ready');
    assert.equal(processing.processing, true);
    // Past processing, and past the access token's hour: the API answers 401 once, the
    // token is renewed and the probe goes on.
    clock.advance(3_700_000);
    const online = await host.withSession((s) => s.probe(receipt.submittedVideoId));
    assert.equal(online.outcome, 'online', JSON.stringify(online));
    assert.match(online.quality, /\d+p/);
    assert.equal(online.stored.title, job.title);
    assert.deepEqual(online.stored.tags, ['tennis', 'final']);
    assert.equal(check.fingerprint, (await host.session.check()).fingerprint, 'the same login across rotations');

    const found = await host.findUploadedCopy(job.uploadIdentity);
    assert.deepEqual(found, { kind: 'found', remoteId: receipt.submittedVideoId, remoteUrl: online.remoteUrl });
    assert.deepEqual(await host.findUploadedCopy('2026-06-01 130000 nobody'), { kind: 'not_found' });
    const again = await host.upload(request(artifact, job.uploadIdentity, { lookupBeforeUpload: true }));
    assert.deepEqual(again, { kind: 'existing', remoteId: receipt.submittedVideoId, remoteUrl: online.remoteUrl });
    assert.equal(events('video-created').length, 1, 'the lookup found it: no second copy');
});

test('a refused word and a used-up quota fail before anything is created', async (t) => {
    // A create costs 100 units, refused or not.
    const { artifact, make, events } = await start(t, { quota: { dailyUnits: 250 } });
    const host = make();
    const refused = await host.upload(request(artifact, 'id-1', { title: 'A forbidden final [id-1]' })).catch((error) => error);
    assert.ok(refused instanceof MetadataRejectedError, String(refused));
    assert.deepEqual(refused.phrases, ['forbidden']);
    assert.equal((await host.upload(request(artifact, 'id-2'))).kind, 'uploaded');
    const quota = await host.upload(request(artifact, 'id-3')).catch((error) => error);
    assert.ok(quota instanceof HumanActionRequiredError && quota.action === 'daily_limit', String(quota));
    assert.equal(events('video-created').length, 1);
});

test('requests dropped half-way are resumed from the host\'s offset, every byte exact', async (t) => {
    const { sim, clock, artifact, make } = await start(t, { faults: [{ type: 'uploadFault', mode: 'drop', at: 0, until: 20 }] });
    const host = make();
    const job = request(artifact, 'id-drop');
    // The first request is dropped half-way; the window closes before the next one.
    let sent = 0;
    job.onProgress = (phase, bytes) => { job.progress.push([phase, bytes]); if (bytes > 0 && ++sent === 2) clock.set(EPOCH + 30_000); };
    const { receipt } = await host.upload(job);
    assert.equal((await video(sim, host, receipt.submittedVideoId)).fileDetails.sha256, sha256(artifact));
    assert.ok(receipt.transmittedBytes > job.sizeBytes, 'some requests were sent again');
});

test('an attempt that stops half-way is no copy; the next one resumes the same video', async (t) => {
    const { sim, clock, artifact, make, events } = await start(t, { faults: [{ type: 'uploadFault', mode: 'status', status: 503, at: 20, until: 3600 }] });
    const host = make({ chunkAttempts: 2 });
    const job = request(artifact, 'id-stop');
    // The first request lands before the fault window; the rest fail.
    let sent = 0;
    job.onProgress = (phase, bytes) => { job.progress.push([phase, bytes]); if (bytes > 0 && ++sent === 2) clock.set(EPOCH + 30_000); };
    const stopped = await host.upload(job).catch((error) => error);
    assert.ok(stopped instanceof UploadTransportError && stopped.acceptanceUnknown, String(stopped));
    const [created] = events('video-created');
    assert.equal((await host.withSession((s) => s.lookup(job.uploadIdentity))).kind, 'absent', 'an incomplete upload is no copy');
    const exact = await host.withSession((s) => s.lookup('', created.video));
    assert.equal(exact.kind, 'found');
    assert.equal(exact.failed, true);

    clock.set(EPOCH + 4_000_000);
    const retry = request(artifact, 'id-stop');
    const { receipt } = await host.upload(retry);
    assert.equal(receipt.submittedVideoId, created.video, 'the same video');
    assert.equal(events('video-created').length, 1, 'no second video');
    assert.equal(retry.evidence[0].replay, true);
    assert.ok(receipt.transmittedBytes < retry.sizeBytes, 'only the missing bytes were sent');
    const offsets = events('upload-bytes').map((e) => e.offset);
    assert.equal(offsets[0], 0);
    assert.ok(offsets.every((offset, i) => i === 0 || offset > offsets[i - 1]), 'the host never received a byte twice');
    assert.equal((await video(sim, host, created.video)).fileDetails.sha256, sha256(artifact));
});

test('a spent refresh token or a revocation signs in again with the password, unless that is off', async (t) => {
    const { artifact, stateDir, make, events } = await start(t);
    const first = make();
    await first.upload(request(artifact, 'id-a'));
    const spent = stored(stateDir).refreshToken;
    assert.equal((await first.session.check()).loggedIn, true);
    assert.notEqual(stored(stateDir).refreshToken, spent, 'the renewal rotated the token, saved at once');
    // A power cut between the host's rotation and the durable write: the spent token is
    // what the disk holds. Its renewal is refused (and revokes the family); the next use
    // signs in again.
    writeFileSync(path.join(stateDir, 'session.json'), JSON.stringify({ ...stored(stateDir), refreshToken: spent }));
    const second = make();
    assert.equal((await second.session.check()).loggedIn, false);
    await second.upload(request(artifact, 'id-b'));
    assert.equal(events('login').length, 2);

    const strict = make({ allowPasswordLogin: false });
    writeFileSync(path.join(stateDir, 'session.json'), JSON.stringify({ ...stored(stateDir), refreshToken: spent }));
    const lost = await strict.upload(request(artifact, 'id-c')).catch((error) => error);
    assert.ok(lost instanceof ProviderSessionLostError, String(lost));
    assert.match(strict.session.lostAdvice, /password logins are off/);
});

test('a list page that fails is an incomplete listing, never "absent"; a deleted video is missing', async (t) => {
    const { sim, clock, artifact, make } = await start(t, { faults: [{ type: 'apiStatus', api: 'list', status: 503, at: 100, until: 200 }] });
    const host = make();
    const { receipt } = await host.upload(request(artifact, 'id-list'));
    clock.set(EPOCH + 150_000);
    await assert.rejects(host.withSession((s) => s.lookup('id-nobody')), /listing is incomplete/);
    clock.set(EPOCH + 300_000);
    const token = await host.tokens.bearer();
    assert.equal((await fetch(`${sim.urls['api-host']}/v1/videos/${receipt.submittedVideoId}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })).status, 204);
    const gone = await host.withSession((s) => s.probe(receipt.submittedVideoId));
    assert.equal(gone.outcome, 'missing');
    assert.equal(gone.removed, true);
});
