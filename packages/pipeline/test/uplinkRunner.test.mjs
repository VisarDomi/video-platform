// An upload from another uplink: the PC's remote destination drives a runner over its
// stdin/stdout. A scripted runner checks the PC's side (acks awaited, a runner that dies
// before or after the creation boundary, a stale runner refused, the session never in
// arguments or the environment); the real runner uploads to the simulated form host from
// a directory carrier, checks its network and the file, and hands a replaced session back.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MetadataRejectedError, TransferAbortedBeforeSubmissionError, UploadTransportError } from 'sdk';
import { MediaLibrary, SimClock, prepAll, startSimulator } from 'simulator';
import { destination as formHost } from 'plugin-form-host';
import { RemoteDestination } from '../dist/upload/remoteDestination.js';
import { RunnerConnection } from '../dist/uplink/runnerConnection.js';
import { normalizeHardwareAddress, parseDefaultRoute, parseNeighbour } from '../dist/uplink/networkIdentity.js';

const RUNNER = fileURLToPath(new URL('../dist/uplinkRunner.js', import.meta.url));
const SECRET = 'cookie-value-that-must-stay-in-stdin';

function scratch(t, prefix) {
    const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    return directory;
}

// A runner that follows a script: hello, then the steps after the upload line.
function scriptedRunner(t, steps, { commit = 'c1', protocol = 1 } = {}) {
    const directory = scratch(t, 'uplink-scripted-');
    const log = path.join(directory, 'log.jsonl');
    const script = path.join(directory, 'runner.mjs');
    writeFileSync(script, `
import { appendFileSync } from 'node:fs';
const log = (entry) => appendFileSync(${JSON.stringify(log)}, JSON.stringify({ at: Date.now(), ...entry }) + '\\n');
log({ argv: process.argv, env: process.env });
const send = (message) => new Promise((resolve) => process.stdout.write(JSON.stringify(message) + '\\n', resolve));
let buffered = '', waiting = null; const lines = [];
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { buffered += chunk; let i; while ((i = buffered.indexOf('\\n')) >= 0) { const line = JSON.parse(buffered.slice(0, i)); buffered = buffered.slice(i + 1); if (line.type === 'ping') continue; if (waiting) { const w = waiting; waiting = null; w(line); } else lines.push(line); } });
const next = () => lines.length ? Promise.resolve(lines.shift()) : new Promise((resolve) => { waiting = resolve; });
await send({ type: 'hello', protocol: ${protocol}, commit: ${JSON.stringify(commit)} });
const upload = await next();
log({ upload });
let seq = 0;
for (const step of ${JSON.stringify(steps)}) {
    if (step === 'die') process.exit(3);
    const message = { ...step, seq: ++seq };
    log({ sent: message.type, phase: message.phase });
    await send(message);
    if (['progress', 'evidence', 'session'].includes(message.type)) { const answer = await next(); log({ answer: answer.type, seq: answer.seq }); }
}
process.exit(0);
`);
    return { command: [process.execPath, script], log: () => readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) };
}

function fakePlugin(adopted) {
    return {
        id: 'fake', readSharedSession: async () => ({ cookies: [{ name: 'sid', value: SECRET, domain: 'x', path: '/' }], fingerprint: 'f1', savedAt: 'now' }),
        adoptSharedSession: async (_config, session) => { adopted.push(session); },
    };
}

const local = { creationBoundary: 'metadata_submit', session: { check: async () => ({}), lostAdvice: '' },
    findUploadedCopy: async () => ({ kind: 'not_found' }), withSession: async () => null, upload: async () => { throw new Error('local'); } };

function remote(command, plugin, stopSignal) {
    return new RemoteDestination(local, plugin, { id: 'fake', plugin: 'plugin-fake' }, '/unused', {
        uplink: { id: 'office', dailyBytes: 1, network: { gateway: 'office-net' }, carrier: { path: '/c', capacityBytes: 1, remoteMount: '/c' }, runner: command, minFreeBytes: 1 },
        carrier: { root: '/c', id: 'c' }, file: { name: 'a.mp4', sha256: 'h' }, expectedCommit: 'c1', stopSignal,
    });
}

function request(recorded, delayMs = 0) {
    return {
        recordingId: 'r', uploadIdentity: 'r', artifactPath: '/pc/only/a.mp4', sizeBytes: 100, title: 't [r]', description: 'd', tags: [],
        visibility: 'public',
        onProgress: async (phase, bytes) => { await new Promise((resolve) => setTimeout(resolve, delayMs)); recorded.push({ phase, bytes, at: Date.now() }); },
        onEvidence: async (evidence) => { recorded.push({ evidence }); },
    };
}

test('every report is recorded before the runner goes on; the result comes back; a replaced session is adopted', async (t) => {
    const runner = scriptedRunner(t, [
        { type: 'progress', phase: 'file_uploading', bytes: 50 },
        { type: 'progress', phase: 'file_uploaded', bytes: 100 },
        { type: 'evidence', evidence: { stage: 'file_transfer_complete' } },
        { type: 'progress', phase: 'metadata_submitting', bytes: 100 },
        { type: 'session', session: { cookies: [{ name: 'sid', value: 'new', domain: 'x', path: '/' }], fingerprint: 'f2', savedAt: 'later' } },
        { type: 'result', outcome: { kind: 'uploaded', receipt: { transmittedBytes: 100, submittedVideoId: '7', metadataSubmittedAt: '2026-06-01T00:00:00.000Z' } } },
    ]);
    const recorded = [], adopted = [];
    const outcome = await remote(runner.command, fakePlugin(adopted)).upload(request(recorded, 150));
    assert.deepEqual(outcome, { kind: 'uploaded', receipt: { transmittedBytes: 100, submittedVideoId: '7', metadataSubmittedAt: '2026-06-01T00:00:00.000Z' } });
    assert.deepEqual(recorded.map((entry) => entry.phase ?? entry.evidence.stage), ['file_uploading', 'file_uploaded', 'file_transfer_complete', 'metadata_submitting']);
    assert.deepEqual(adopted.map((session) => session.fingerprint), ['f2']);
    const log = runner.log();
    // The runner sent each next line only after the PC had recorded the previous one.
    const sent = log.filter((entry) => entry.sent);
    for (let i = 1; i < sent.length - 1 && i < recorded.length; i++) {
        if (recorded[i - 1].at) assert.ok(sent[i].at >= recorded[i - 1].at, `line ${i} waited for the record`);
    }
    const upload = log.find((entry) => entry.upload).upload;
    assert.equal(upload.request.artifactPath, 'a.mp4', 'the runner gets the carrier name, not the PC path');
    assert.equal(upload.session.cookies[0].value, SECRET, 'the session travels in the upload line');
    const start = JSON.stringify(log[0]);
    assert.ok(!start.includes(SECRET), 'never in arguments or the environment');
});

test('a runner that ends before the metadata step is a plain failure; after it, acceptance is unknown', async (t) => {
    const before = scriptedRunner(t, [{ type: 'progress', phase: 'file_uploading', bytes: 40 }, 'die']);
    await assert.rejects(remote(before.command, fakePlugin([])).upload(request([])), (error) => {
        assert.ok(error instanceof UploadTransportError);
        assert.equal(error.acceptanceUnknown, false);
        assert.equal(error.transmittedBytes, 40);
        assert.match(error.message, /ended without a result \(exit 3/);
        return true;
    });
    const after = scriptedRunner(t, [{ type: 'progress', phase: 'metadata_submitting', bytes: 100 }, 'die']);
    await assert.rejects(remote(after.command, fakePlugin([])).upload(request([])), (error) => {
        assert.ok(error instanceof UploadTransportError);
        assert.equal(error.acceptanceUnknown, true);
        return true;
    });
});

test('a runner error keeps its class before the metadata step; after it, only a refused form does', async (t) => {
    const aborted = { name: 'TransferAbortedBeforeSubmissionError', message: 'stopped' };
    const early = scriptedRunner(t, [{ type: 'progress', phase: 'file_uploading', bytes: 1 }, { type: 'error', error: aborted }]);
    await assert.rejects(remote(early.command, fakePlugin([])).upload(request([])), TransferAbortedBeforeSubmissionError);
    const late = scriptedRunner(t, [{ type: 'progress', phase: 'metadata_submitting', bytes: 1 }, { type: 'error', error: aborted }]);
    await assert.rejects(remote(late.command, fakePlugin([])).upload(request([])), (error) => error instanceof UploadTransportError && error.acceptanceUnknown);
    const refused = scriptedRunner(t, [{ type: 'progress', phase: 'metadata_submitting', bytes: 1 },
        { type: 'error', error: { name: 'MetadataRejectedError', message: 'x', phrases: ['bad'] } }]);
    await assert.rejects(remote(refused.command, fakePlugin([])).upload(request([])), (error) => error instanceof MetadataRejectedError && error.phrases[0] === 'bad');
});

test('a runner of another commit or protocol is refused before anything is sent', async (t) => {
    const stale = scriptedRunner(t, [], { commit: 'old' });
    await assert.rejects(remote(stale.command, fakePlugin([])).upload(request([])),
        (error) => error instanceof TransferAbortedBeforeSubmissionError && /commit old, the PC deployed c1; deploy the runner again/.test(error.message));
    assert.equal(stale.log().filter((entry) => entry.upload).length, 0, 'no upload line, no session');
    const other = scriptedRunner(t, [], { protocol: 2 });
    await assert.rejects(RunnerConnection.open(other.command, 'c1'), /protocol 2/);
    await assert.rejects(RunnerConnection.open(['/nonexistent/runner'], 'c1'), /did not answer/);
});

test('gateway lookups: Linux and macOS outputs, octets without leading zeros', () => {
    assert.deepEqual(parseDefaultRoute('linux', 'default via 192.168.1.1 dev eno1 proto static metric 100 \n'), { gateway: '192.168.1.1', device: 'eno1' });
    assert.deepEqual(parseDefaultRoute('darwin', '   route to: default\ndestination: default\n    gateway: 192.168.1.1\n  interface: en4\n'), { gateway: '192.168.1.1', device: 'en4' });
    assert.equal(parseDefaultRoute('linux', ''), null);
    assert.equal(parseNeighbour('linux', '192.168.1.1 dev eno1 lladdr 4c:06:17:75:fa:54 REACHABLE'), '4c:06:17:75:fa:54');
    assert.equal(parseNeighbour('darwin', '? (192.168.1.1) at e4:72:9d:26:4c:70 on en4 ifscope [ethernet]'), 'e4:72:9d:26:4c:70');
    assert.equal(parseNeighbour('darwin', '? (192.168.1.1) at 4c:6:17:75:fa:5 on en0 ifscope [ethernet]'), '4c:06:17:75:fa:05');
    assert.equal(parseNeighbour('darwin', '? (192.168.1.1) at (incomplete) on en0 ifscope [ethernet]'), null);
    assert.equal(normalizeHardwareAddress('00:00:00:00:00:00'), null);
});

// ---- the real runner against the simulated form host ----

const EPOCH = Date.parse('2026-06-01T12:00:00.000Z');
let fixtures = null;
function media() {
    fixtures ??= (async () => {
        const root = mkdtempSync(path.join(os.tmpdir(), 'uplink-media-'));
        process.on('exit', () => rmSync(root, { recursive: true, force: true }));
        const make = (file, size, seconds) => execFileSync('nice', ['-n', '19', 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=25`, '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', file]);
        mkdirSync(path.join(root, 'in'));
        make(path.join(root, 'in', 'Practice.mkv'), '320x180', 2);
        await prepAll({ input: path.join(root, 'in'), out: path.join(root, 'cache') });
        const artifact = path.join(root, 'match.mp4');
        make(artifact, '1920x1080', 1);
        return { library: MediaLibrary.load(path.join(root, 'cache')), artifact };
    })();
    return fixtures;
}

async function realSetup(t) {
    const { library, artifact } = await media();
    const clock = new SimClock({ mode: 'manual', at: EPOCH + 10_000 });
    const sim = await startSimulator({
        scenario: { name: 'uplink', seed: 'uplink', epoch: EPOCH, sites: { 'form-host': {
            accounts: [{ username: 'coach', password: 'pw', displayName: 'Coach' }], chunkSize: 65536, processingS: 60,
            rotateSessionS: 3600, rotationGraceS: 30 } } },
        media: library, clock, autoPublish: false, memoryTruth: true, host: '127.0.0.1',
    });
    t.after(() => sim.close());
    const root = scratch(t, 'uplink-real-');
    const stateDir = path.join(root, 'state');
    mkdirSync(stateDir, { mode: 0o700 });
    const entry = { id: 'form-host', plugin: 'plugin-form-host', config: { baseUrl: sim.urls['form-host'], retryDelayMs: 0 } };
    const pc = formHost.createDestination({ config: entry.config, stateDir, browser: { executablePath: '/unused', profilePath: '/unused' },
        credentials: () => ({ email: 'coach', password: 'pw' }), stopSignal: new AbortController().signal });
    // The PC signs in once with an upload of its own.
    const warm = { recordingId: 'w', uploadIdentity: 'warm', artifactPath: artifact, sizeBytes: statSync(artifact).size,
        title: 'Warm [warm]', description: 'd', tags: [], visibility: 'public' };
    assert.equal((await pc.upload(warm)).kind, 'uploaded');
    // The carrier: a directory with its marker and the file.
    const carrier = path.join(root, 'carrier');
    mkdirSync(path.join(carrier, 'files'), { recursive: true });
    writeFileSync(path.join(carrier, 'carrier.json'), JSON.stringify({ carrier: 'carrier', version: 1 }));
    copyFileSync(artifact, path.join(carrier, 'files', 'match.mp4'));
    const network = path.join(root, 'network');
    writeFileSync(network, 'office-net\n');
    const info = path.join(root, 'runner.json');
    writeFileSync(info, JSON.stringify({ commit: 'c1' }));
    const command = ['env', `VIDEO_UPLINK_RUNNER_INFO=${info}`, 'VIDEO_CHROMIUM_PATH=/unused', process.execPath, '--no-warnings', RUNNER];
    const sha256 = createHash('sha256').update(readFileSync(artifact)).digest('hex');
    const make = (overrides = {}) => new RemoteDestination(pc, formHost, entry, stateDir, {
        uplink: { id: 'office', dailyBytes: 1, network: { gateway: 'office-net', probe: ['cat', network] },
            carrier: { path: carrier, capacityBytes: 1, remoteMount: carrier }, runner: command, minFreeBytes: 1 },
        carrier: { root: carrier, id: 'carrier' }, file: { name: 'match.mp4', sha256 }, expectedCommit: 'c1', ...overrides,
    });
    const events = (name) => sim.memory.records.filter((r) => r.type === 'event' && r.site === 'form-host' && r.event === name);
    return { clock, artifact, stateDir, network, carrier, make, events, command };
}

function job(artifact, identity, recorded) {
    return { recordingId: identity, uploadIdentity: identity, artifactPath: '/pc/artifacts/match.mp4', sizeBytes: statSync(artifact).size,
        title: `Final [${identity}]`, description: 'Centre court.', tags: ['tennis'], visibility: 'public',
        onProgress: (phase, bytes) => { recorded.push(phase); }, onEvidence: (item) => { recorded.push(item.stage); } };
}

test('the real runner uploads the carrier copy on the PC\'s session and hands the replaced session back', async (t) => {
    const { clock, artifact, stateDir, make, events } = await realSetup(t);
    clock.advance(3_601_000);
    const before = (await formHost.readSharedSession({}, stateDir)).fingerprint;
    const recorded = [];
    const outcome = await make().upload(job(artifact, 'court-one', recorded));
    assert.equal(outcome.kind, 'uploaded');
    assert.match(outcome.receipt.submittedVideoId, /^\d+$/);
    assert.deepEqual([...new Set(recorded)], ['file_uploading', 'file_uploaded', 'file_transfer_complete', 'metadata_submitting', 'remote_identity_captured']);
    assert.equal(events('login').length, 1, 'the runner never signed in');
    assert.notEqual((await formHost.readSharedSession({}, stateDir)).fingerprint, before, 'the PC stored the replaced session');
    assert.equal(events('video-created').at(-1).title, 'Final [court-one]');
});

test('the real runner refuses another network, another carrier and a file that does not match, sending nothing', async (t) => {
    const { artifact, network, carrier, make, events } = await realSetup(t);
    const created = events('video-created').length;
    writeFileSync(network, 'home-net\n');
    await assert.rejects(make().upload(job(artifact, 'court-two', [])),
        (error) => error instanceof TransferAbortedBeforeSubmissionError && /on network home-net, not the uplink's/.test(error.message));
    writeFileSync(network, 'office-net\n');
    await assert.rejects(make({ carrier: { root: carrier, id: 'other' } }).upload(job(artifact, 'court-two', [])),
        (error) => error instanceof TransferAbortedBeforeSubmissionError && /carrier other is not at/.test(error.message));
    await assert.rejects(make({ file: { name: 'match.mp4', sha256: '0'.repeat(64) } }).upload(job(artifact, 'court-two', [])),
        (error) => error instanceof TransferAbortedBeforeSubmissionError && /does not match its ledger hash/.test(error.message));
    await assert.rejects(make({ file: { name: '../carrier.json', sha256: 'x' } }).upload(job(artifact, 'court-two', [])),
        /not a plain file name/);
    assert.equal(events('video-created').length, created);
});

test('the real runner answers a probe: its network, the carrier and its files', async (t) => {
    const { carrier, command } = await realSetup(t);
    const answer = await RunnerConnection.ask(command, 'c1', { type: 'probe', network: { gateway: 'office-net', probe: ['cat', path.join(path.dirname(carrier), 'network')] },
        carrier: { root: carrier, id: 'carrier' } }, 'probe');
    assert.equal(answer.identity, 'office-net');
    assert.equal(answer.onUplink, true);
    assert.equal(answer.carrier.matches, true);
    assert.deepEqual(answer.carrier.files.map((file) => file.name), ['match.mp4']);
    assert.equal(answer.commit, 'c1');
    const released = await RunnerConnection.ask(command, 'c1', { type: 'release', carrier: { root: carrier, id: 'carrier' } }, 'released');
    assert.equal(released.unmounted, false, 'a directory carrier has nothing to unmount');
});
