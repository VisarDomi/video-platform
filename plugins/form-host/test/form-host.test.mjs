// form-host against the simulator, in process: ephemeral ports on 127.0.0.1, a manual
// clock, a tiny generated source for the simulator's library and a one-second full-HD
// artifact to upload (ffmpeg under nice). Every address comes from the config, as in the
// sites file.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HumanActionRequiredError, MetadataRejectedError, ProviderSessionLostError, SDK_VERSION } from 'sdk';
import { MediaLibrary, SimClock, prepAll, startSimulator } from 'simulator';
import { destination, pages, readConfig } from '../dist/index.js';

const EPOCH = Date.parse('2026-06-01T12:00:00.000Z');

function makeVideo(file, size, seconds) {
    execFileSync('nice', ['-n', '19', 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=25`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-threads', '2', '-c:a', 'aac', '-b:a', '48k', file]);
}

let fixtures = null;
// One library and one artifact per test process.
function media() {
    fixtures ??= (async () => {
        const root = mkdtempSync(path.join(os.tmpdir(), 'form-host-plugin-'));
        process.on('exit', () => rmSync(root, { recursive: true, force: true }));
        mkdirSync(path.join(root, 'in'));
        makeVideo(path.join(root, 'in', 'Practice.mkv'), '320x180', 2);
        await prepAll({ input: path.join(root, 'in'), out: path.join(root, 'cache') });
        const artifact = path.join(root, 'match.mp4');
        makeVideo(artifact, '1920x1080', 1);
        return { library: MediaLibrary.load(path.join(root, 'cache')), artifact };
    })();
    return fixtures;
}

async function start(t, extra = {}, { at = EPOCH + 10_000 } = {}) {
    const { library, artifact } = await media();
    const clock = new SimClock({ mode: 'manual', at });
    const sim = await startSimulator({
        scenario: { name: 'form-host plug-in', seed: 'form-host-plugin', epoch: EPOCH, sites: { 'form-host': {
            accounts: [{ username: 'coach', password: 'pw', displayName: 'Coach' }],
            chunkSize: 65536, processingS: 60, rotateSessionS: 3600, rotationGraceS: 30,
            bannedWords: [{ word: 'forbidden', action: 'refuse' }], ...extra,
        } } },
        media: library, clock, autoPublish: false, memoryTruth: true, host: '127.0.0.1',
    });
    t.after(() => sim.close());
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'form-host-state-'));
    t.after(() => rmSync(stateDir, { recursive: true, force: true }));
    const stop = new AbortController();
    t.after(() => stop.abort());
    const make = (config = {}) => destination.createDestination({
        config: { baseUrl: sim.urls['form-host'], retryDelayMs: 0, ...config }, stateDir,
        browser: { executablePath: '/unused', profilePath: '/unused' },
        credentials: () => ({ email: 'coach', password: 'pw' }), stopSignal: stop.signal,
    });
    const control = (action, body = {}) => fetch(`${sim.urls.control}/sites/form-host/${action}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const events = (name) => sim.memory.records.filter((r) => r.type === 'event' && r.site === 'form-host' && r.event === name);
    return { sim, clock, artifact, stateDir, make, control, events };
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

test('the plug-in declares the SDK version and reads its config', () => {
    assert.equal(destination.sdkVersion, SDK_VERSION);
    assert.equal(destination.id, 'form-host');
    const config = readConfig({ baseUrl: 'http://127.0.0.1:1/' });
    assert.equal(config.baseUrl, 'http://127.0.0.1:1');
    assert.deepEqual(config.categoryIds, ['21']);
    assert.equal(config.allowPasswordLogin, true);
    assert.throws(() => readConfig({}), /baseUrl/);
    assert.throws(() => readConfig({ baseUrl: 'http://x', categoryIds: [] }), /categoryIds/);
    assert.throws(() => readConfig({ baseUrl: 'http://x', chunkAttempts: 0 }), /chunkAttempts/);
});

test('page readers: entities, refused words, list rows and renditions', () => {
    assert.equal(pages.unescapeHtml('Tom &#38; Jerry&#39;s &amp; &lt;b&gt; &#x27;x&#x27;'), "Tom & Jerry's & <b> 'x'");
    assert.deepEqual(pages.refusedWords("Sorry, 'forbidden' is not allowed here. Sorry, 'x y' is not allowed here."), ['forbidden', 'x y']);
    const block = `<div id="list_videos_my_uploaded_videos" data-page="1" data-pages="2">
<div class="list-videos"><div class="item processing" data-item-id="11"><p class="inf"><a href="">A &#38; B [id-1]</a></p><span class="line-processing">Processing</span></div>
<div class="item error" data-item-id="12"><p class="inf"><span class="title">Broken [id-2]</span></p><span class="line-error">Error</span></div>
<div class="item" data-item-id="13"><p class="inf"><a href="/video/13/done/">Done [id-3]</a></p><span class="line-limited">Limited visibility due to : rule</span><a class="edit" href="/edit-video/13/">Edit</a></div></div></div>`;
    assert.deepEqual(pages.listPage(block), { page: 1, pages: 2, videos: [
        { id: '11', title: 'A & B [id-1]', path: null, processing: true, failed: false, limited: null },
        { id: '12', title: 'Broken [id-2]', path: null, processing: false, failed: true, limited: null },
        { id: '13', title: 'Done [id-3]', path: '/video/13/done/', processing: false, failed: false, limited: 'rule' },
    ] });
    const player = '<script>var flashvars = {"video_url":"http://h/360","video_url_text":"360p","video_alt_url":"http://h/1080","video_alt_url_text":"1080p FHD"};</script>';
    assert.deepEqual(pages.renditions(player).map((r) => r.label), ['1080p FHD', '360p']);
});

test('upload signs in, sends the chunks, submits the form and captures the ID; verification waits for processing', async (t) => {
    const { clock, artifact, stateDir, make, events } = await start(t);
    const host = make();
    assert.equal((await host.session.check()).loggedIn, false, 'no session yet');
    const job = request(artifact, '2026-06-01 120000 court-one');
    const outcome = await host.upload(job);
    assert.equal(outcome.kind, 'uploaded');
    const { receipt } = outcome;
    assert.match(receipt.submittedVideoId, /^\d+$/);
    assert.equal(events('login').length, 1, 'one password login');
    assert.equal(statSync(path.join(stateDir, 'session.json')).mode & 0o777, 0o600);
    const phases = job.progress.map(([phase]) => phase);
    assert.deepEqual([...new Set(phases)], ['file_uploading', 'file_uploaded', 'metadata_submitting']);
    assert.equal(phases.filter((p) => p === 'file_uploading').length, Math.ceil(job.sizeBytes / 65536), 'one progress note per chunk');
    assert.ok(receipt.transmittedBytes >= job.sizeBytes);
    assert.deepEqual(job.evidence.map((e) => e.stage), ['file_transfer_complete', 'remote_identity_captured']);
    assert.equal(events('video-created')[0].title, job.title);

    const check = await host.session.check();
    assert.equal(check.loggedIn, true);
    assert.match(check.fingerprint, /^[0-9a-f]{12}$/);
    assert.ok(check.passwordLoginAt);

    const processing = await host.withSession((s) => s.probe(receipt.submittedVideoId));
    assert.equal(processing.outcome, 'not_ready');
    assert.equal(processing.processing, true);
    clock.advance(61_000);
    const online = await host.withSession((s) => s.probe(receipt.submittedVideoId));
    assert.equal(online.outcome, 'online', JSON.stringify(online));
    assert.equal(online.quality, '1080p FHD');
    assert.match(online.remoteUrl, new RegExp(`/video/${receipt.submittedVideoId}/final-set-`));
    assert.equal(online.stored.title, job.title);
    assert.deepEqual(online.stored.tags, ['tennis', 'final']);

    const found = await host.findUploadedCopy(job.uploadIdentity);
    assert.deepEqual(found, { kind: 'found', remoteId: receipt.submittedVideoId, remoteUrl: online.remoteUrl });
    assert.deepEqual(await host.findUploadedCopy('2026-06-01 130000 nobody'), { kind: 'not_found' });
    const again = await host.upload(request(artifact, job.uploadIdentity, { lookupBeforeUpload: true }));
    assert.deepEqual(again, { kind: 'existing', remoteId: receipt.submittedVideoId, remoteUrl: online.remoteUrl });
    assert.equal(events('video-created').length, 1, 'the lookup found it: no second copy');
});

test('a refused word fails definitively and creates nothing', async (t) => {
    const { artifact, make, events } = await start(t);
    const host = make();
    const job = request(artifact, '2026-06-01 120000 court-two', { description: 'A forbidden rally.' });
    await assert.rejects(host.upload(job), (error) => error instanceof MetadataRejectedError && error.phrases.join() === 'forbidden');
    assert.equal(job.progress.at(-1)[0], 'metadata_submitting', 'the form was sent');
    assert.equal(events('video-created').length, 0);
    assert.deepEqual(await host.findUploadedCopy(job.uploadIdentity), { kind: 'not_found' });
});

test('a dropped chunk is sent again under its index', async (t) => {
    const { sim, clock, artifact, make, events } = await start(t, { faults: [{ type: 'chunkFault', at: 0, until: 50, mode: 'drop', index: 1 }] });
    const host = make({ retryDelayMs: 1500 });
    const job = request(artifact, '2026-06-01 120000 court-five');
    const upload = host.upload(job);
    // Once the host has dropped chunk 2 (index 1), the fault window ends before the retry.
    while (!sim.memory.records.some((r) => JSON.stringify(r).includes('chunk 1 dropped'))) await new Promise((r) => setTimeout(r, 20));
    clock.set(EPOCH + 51_000);
    const outcome = await upload;
    assert.equal(outcome.kind, 'uploaded');
    assert.equal(events('video-created').length, 1);
    assert.deepEqual(events('chunk').map((e) => e.index), [...Array(Math.ceil(job.sizeBytes / 65536)).keys()], 'every index stored once, in order');
    assert.ok(outcome.receipt.transmittedBytes >= job.sizeBytes + 65536, 'the dropped chunk counts as sent');
    // Every send is recorded before it leaves, the dropped one too: the core bills them all.
    const sends = job.progress.filter(([phase]) => phase === 'file_uploading');
    assert.equal(sends.length, Math.ceil(job.sizeBytes / 65536) + 1);
    assert.equal(sends.at(-1)[1], outcome.receipt.transmittedBytes);
});

test('a chunk that keeps failing stops the transfer before the metadata form', async (t) => {
    const { artifact, make, events } = await start(t, { faults: [{ type: 'chunkFault', at: 0, until: 50, mode: 'drop', index: 1 }] });
    const host = make({ chunkAttempts: 2 });
    // The fault holds for the whole window: index 1 fails every time, so the transfer stops
    // before the metadata form (nothing published).
    const job = request(artifact, '2026-06-01 120000 court-three');
    await assert.rejects(host.upload(job), /chunk 2 of \d+ failed 2 times/);
    assert.ok(!job.progress.some(([phase]) => phase === 'metadata_submitting'));
    assert.equal(job.progress.filter(([phase]) => phase === 'file_uploading').length, 3, 'chunk 1, then chunk 2 twice: all recorded as sent');
    assert.equal(events('video-created').length, 0);
});

test('signed out: a password login when allowed; the remember-me cookie restores the session without it', async (t) => {
    const { artifact, make, control, events } = await start(t);
    const strict = make({ allowPasswordLogin: false });
    await assert.rejects(strict.upload(request(artifact, '2026-06-01 120000 a')), ProviderSessionLostError);
    assert.equal(events('login').length, 0, 'never a password login when it is off');

    const host = make();
    await host.withSession(async () => {});
    assert.equal(events('login').length, 1);
    // Signed out, remember-me kept: the next page view signs in from the cookie.
    await control('logout', { account: 'coach', revokeRemember: false });
    assert.equal((await strict.session.check()).loggedIn, true, 'the remember-me cookie signed in again');
    assert.equal(events('login').filter((e) => e.via === 'password').length, 1, 'without the password');
    // Signed out everywhere: only the password helps, and only where it is allowed.
    await control('logout', { account: 'coach', revokeRemember: true });
    assert.equal((await strict.session.check()).loggedIn, false);
    await assert.rejects(strict.withSession(async () => {}), ProviderSessionLostError);
    await host.withSession(async () => {});
    assert.equal(events('login').filter((e) => e.via === 'password').length, 2);
});

test('a list page that should exist but answers 404 is an incomplete listing, never "absent"', async (t) => {
    const { clock, make } = await start(t, { pageSize: 1, faults: [{ type: 'listStatus', at: 100, until: 110, status: 404 }] });
    const host = make();
    await host.withSession(async () => {});
    clock.set(EPOCH + 105_000);
    await assert.rejects(host.findUploadedCopy('2026-06-01 120000 x'), /listing is incomplete/);
    clock.set(EPOCH + 111_000);
    assert.deepEqual(await host.findUploadedCopy('2026-06-01 120000 x'), { kind: 'not_found' });
});

test('a removed video is missing; a cached upload page is inconclusive', async (t) => {
    const { clock, artifact, make, control } = await start(t, { faults: [{ type: 'cacheWindow', at: 500, until: 600, path: '/upload-video/' }] });
    const host = make();
    const { receipt } = await host.upload(request(artifact, '2026-06-01 120000 court-four'));
    clock.advance(61_000);
    assert.equal((await host.withSession((s) => s.probe(receipt.submittedVideoId))).outcome, 'online');
    await control('remove', { id: receipt.submittedVideoId, reason: 'rule' });
    const gone = await host.withSession((s) => s.probe(receipt.submittedVideoId));
    assert.equal(gone.outcome, 'missing');
    assert.equal(gone.removed, true, 'gone from the complete list: removed, not failed');
    assert.match(gone.reason, /complete list/);

    clock.set(EPOCH + 510_000);
    await host.session.check(); // The first request in the window fills the cache.
    await assert.rejects(host.session.check(), /shared cache/);
});

test('a list or login page from a shared cache proves nothing: no "absent", no refused login', async (t) => {
    const { clock, make, sim, control } = await start(t, { faults: [
        { type: 'cacheWindow', at: 500, until: 600, path: '/my/videos/' },
        { type: 'cacheWindow', at: 700, until: 800, path: '/login/' },
    ] });
    const host = make();
    await host.withSession(async () => {});
    clock.set(EPOCH + 510_000);
    // The first scan fills the cache; the second (the stability check) reads it back.
    await assert.rejects(host.findUploadedCopy('2026-06-01 120000 x'), /shared cache/);
    clock.set(EPOCH + 610_000);
    assert.deepEqual(await host.findUploadedCopy('2026-06-01 120000 x'), { kind: 'not_found' });

    clock.set(EPOCH + 710_000);
    await fetch(`${sim.urls['form-host']}/login/`); // Someone else fills the login page's cache.
    await control('logout', { account: 'coach', revokeRemember: true });
    await assert.rejects(host.withSession(async () => {}), (error) => /shared cache/.test(error.message) && !(error instanceof HumanActionRequiredError));
});
