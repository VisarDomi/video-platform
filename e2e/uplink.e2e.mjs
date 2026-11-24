#!/usr/bin/env node
// End-to-end: the second uplink, on one machine. The real pipeline (child processes) converts
// five recordings ahead of a home allowance too small to send any, copies them to a carrier
// (a directory standing in for the drive, with a pull mid-copy repaired by the next pass),
// the "drive" moves to the "office" (another directory, where the runner finds it), and the
// real runner, run here through a wrapper that can kill it, sends them to the simulated form
// host on the PC's shared session: nothing on the wrong network, nothing before a person's
// first upload, a runner killed before the creation boundary (a plain failure, sent again
// after the office lane's own backoff) and one killed after it (uncertain, confirmed from
// the list a day later, never sent twice). Back home, the drive is cleaned.
//
//   npm run build:pipeline && npm run build -w simulator && npm run build:sim-plugins
//   npm run e2e:uplink            (about a minute; E2E_KEEP=1 keeps everything)
//
// Exit status: 0 when every assertion holds, 1 otherwise, 2 when the run could not happen.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = process.env.E2E_KEEP === '1';
const DESTINATION = 'form-host';
for (const file of ['packages/pipeline/dist/main.js', 'packages/pipeline/dist/uplinkRunner.js', 'packages/simulator/dist/index.js',
    'packages/sdk/dist/index.js', 'plugins/form-host/dist/index.js']) {
    if (!existsSync(path.join(ROOT, file))) {
        console.error(`missing ${file}: build first (npm run build:pipeline && npm run build -w simulator && npm run build:sim-plugins)`);
        process.exit(2);
    }
}
const { startSimulator, MediaLibrary, SimClock, prepAll } = await import(path.join(ROOT, 'packages/simulator/dist/index.js'));
const { fixturePart, assemble } = await import(path.join(ROOT, 'packages/pipeline/test/helpers/mediaFixture.mjs'));

const started = Date.now();
const say = (message) => console.log(`[e2e ${((Date.now() - started) / 1000).toFixed(0)}s] ${message}`);

// ---- isolation -----------------------------------------------------------------------

const runDir = mkdtempSync(path.join(os.tmpdir(), 'uplink-e2e-'));
const dirs = Object.fromEntries(['home', 'data', 'downloads', 'media', 'scratch', 'tls', 'pc-usb', 'office-volumes', 'runner-tmp']
    .map((name) => [name, path.join(runDir, name)]));
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
const inside = (parent, child) => { const relative = path.relative(parent, child); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); };
const production = [path.join(os.homedir(), '.local', 'share', 'video-services'), path.join(os.homedir(), '.config', 'video-services')];
const SITE = 'live-a';
const EPOCH = Date.parse('2026-06-01T00:00:00.000Z');
const ledgerPath = path.join(dirs.data, 'pipeline', 'pipeline.sqlite');
const finalizationPath = path.join(dirs.data, 'finalization.sqlite');
const sitesFile = path.join(dirs.data, 'sites.json');
const credentialsFile = path.join(dirs.data, 'upload-providers.json');
const atHome = path.join(dirs['pc-usb'], 'CARRIER1');
const atOffice = path.join(dirs['office-volumes'], 'CARRIER1');
const networkFile = path.join(runDir, 'network');
const killFile = path.join(runDir, 'kill-at');
for (const file of [ledgerPath, finalizationPath, sitesFile, credentialsFile, dirs.downloads, atHome, atOffice]) {
    if (!inside(runDir, file) || production.some((root) => file === root || inside(root, file))) {
        console.error(`isolation guard: ${file} is outside the run directory`);
        process.exit(2);
    }
}

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); say(`${ok ? 'ok  ' : 'FAIL'} ${message}`); };
let sim, model, catalog;
async function cleanup() {
    await sim?.close().catch(() => {});
    await new Promise((resolve) => model ? model.close(resolve) : resolve());
    await new Promise((resolve) => catalog ? catalog.close(resolve) : resolve());
    if (!KEEP) rmSync(runDir, { recursive: true, force: true });
}

try {
    // ---- recordings, simulator, stand-ins (as in pipeline.e2e.mjs) -----------------------

    say('generating five finalized 1080p recordings');
    const names = [1, 2, 3, 4, 5].map((hour) => `2026-06-01 0${hour}0000 court-${hour}`);
    const edited = path.join(dirs.downloads, SITE, 'edited');
    const authority = new DatabaseSync(finalizationPath);
    authority.exec('CREATE TABLE integrity_checkpoints (recording_path TEXT PRIMARY KEY, playlist_fingerprint TEXT NOT NULL, report_json TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT');
    for (const [index, name] of names.entries()) {
        const folder = path.join(edited, name);
        mkdirSync(folder, { recursive: true });
        const part = await fixturePart(dirs.scratch, `part-${index}`, { size: '1920x1080', frames: 40, gop: 10, offset: index * 20 });
        const playlist = await assemble(folder, [part]);
        authority.prepare('INSERT INTO integrity_checkpoints VALUES (?, ?, ?, ?)').run(folder,
            createHash('sha256').update(readFileSync(playlist)).digest('hex'), JSON.stringify({ version: 2, status: 'ready' }), new Date(EPOCH).toISOString());
    }
    authority.close();

    say('starting the simulator (form-host)');
    mkdirSync(path.join(dirs.media, 'in'), { recursive: true });
    execFileSync('nice', ['-n', '19', 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
        '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', path.join(dirs.media, 'in', 'Practice.mkv')]);
    await prepAll({ input: path.join(dirs.media, 'in'), out: path.join(dirs.media, 'cache') });
    const clock = new SimClock({ mode: 'manual', at: EPOCH + 3_600_000 * 11 });
    sim = await startSimulator({
        scenario: { name: 'uplink e2e', seed: 'uplink-e2e', epoch: EPOCH, sites: { [DESTINATION]: {
            accounts: [{ username: 'coach', password: 'pw', displayName: 'Coach' }], chunkSize: 1 << 20, processingS: 120 } } },
        media: MediaLibrary.load(path.join(dirs.media, 'cache')), clock, autoPublish: false, memoryTruth: true, host: '127.0.0.1',
    });
    const events = (name) => sim.memory.records.filter((r) => r.type === 'event' && r.site === DESTINATION && r.event === name);
    const created = () => events('video-created');

    let descriptions = 0;
    model = createHttpServer(async (req, res) => {
        if (req.url === '/health') return res.end('{"status":"ok"}');
        for await (const _ of req) { /* the prompt is not needed */ }
        descriptions++;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: `Baseline rallies, match ${descriptions}`,
            description: 'Two players trade long rallies from the baseline until the last point.' }) } }] }));
    });
    await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
        '-keyout', path.join(dirs.tls, 'key.pem'), '-out', path.join(dirs.tls, 'cert.pem')], { stdio: 'ignore' });
    catalog = createHttpsServer({ key: readFileSync(path.join(dirs.tls, 'key.pem')), cert: readFileSync(path.join(dirs.tls, 'cert.pem')) }, (req, res) => {
        const identifier = new URL(req.url, 'https://127.0.0.1').searchParams.get('identifier');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: `id-${identifier}`, label: identifier, channelUrl: `https://${SITE}.test/id-${identifier}`, aliasUrl: `https://${SITE}.test/@${identifier}` }));
    });
    await new Promise((resolve) => catalog.listen(0, '127.0.0.1', resolve));

    // ---- the runner, behind a wrapper that can kill it --------------------------------------
    // kill-at "file_uploading": killed at its first progress report (before the boundary);
    // kill-at "result": its result is swallowed and it is killed (after the boundary).
    const runnerInfo = path.join(runDir, 'runner.json');
    writeFileSync(runnerInfo, JSON.stringify({ commit: 'e2e' }));
    mkdirSync(path.join(dirs.data, 'pipeline'), { recursive: true });
    writeFileSync(path.join(dirs.data, 'pipeline', 'uplink-runner.json'), JSON.stringify({ commit: 'e2e' }));
    const wrapper = path.join(runDir, 'runner-wrapper.mjs');
    writeFileSync(wrapper, `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
const killAt = existsSync(${JSON.stringify(killFile)}) ? readFileSync(${JSON.stringify(killFile)}, 'utf8').trim() : null;
const child = spawn(process.execPath, ['--no-warnings', ${JSON.stringify(path.join(ROOT, 'packages/pipeline/dist/uplinkRunner.js'))}],
    { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, VIDEO_UPLINK_RUNNER_INFO: ${JSON.stringify(runnerInfo)},
        VIDEO_CHROMIUM_PATH: '/unused', TMPDIR: ${JSON.stringify(dirs['runner-tmp'])} } });
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {});
let buffered = '';
const die = () => { rmSync(${JSON.stringify(killFile)}, { force: true }); child.kill('SIGKILL'); process.exit(9); };
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
    buffered += chunk;
    let i;
    while ((i = buffered.indexOf('\\n')) >= 0) {
        const line = buffered.slice(0, i + 1); buffered = buffered.slice(i + 1);
        const message = JSON.parse(line);
        if (killAt === 'file_uploading' && message.type === 'progress') die();
        if (killAt === 'result' && message.type === 'result') die();
        process.stdout.write(line);
    }
});
child.on('exit', (code) => process.exit(code ?? 1));
`);

    // ---- configuration ----------------------------------------------------------------------

    writeFileSync(sitesFile, JSON.stringify({
        contentProfile: pathToFileURL(path.join(ROOT, 'e2e', 'support', 'profile.mjs')).href,
        destinations: [{ id: DESTINATION, plugin: `plugin-${DESTINATION}`, config: { baseUrl: sim.urls[DESTINATION], retryDelayMs: 100 } }],
        uplink: { id: 'office', dailyBytes: 10_000_000_000, network: { gateway: 'office-net', probe: ['cat', networkFile] },
            carrier: { path: atHome, capacityBytes: 1_000_000_000, remoteMount: atOffice }, minFreeBytes: 1,
            runner: [process.execPath, wrapper] },
        sites: [{ id: SITE, plugin: 'plugin-ts-live' }],
    }, null, 2));
    writeFileSync(credentialsFile, JSON.stringify({ version: 1, providers: { [DESTINATION]: { username: 'coach', password: 'pw' } } }), { mode: 0o600 });
    writeFileSync(networkFile, 'office-net\n');

    let now = EPOCH + 3_600_000 * 11;
    const env = {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VIDEO_') && !key.startsWith('DESCRIPTOR_'))),
        HOME: dirs.home, VIDEO_SERVICES_DATA_ROOT: dirs.data, VIDEO_DOWNLOADS_ROOT: dirs.downloads, VIDEO_SITES_FILE: sitesFile,
        VIDEO_PIPELINE_DB: ledgerPath, VIDEO_FINALIZATION_DB: finalizationPath, VIDEO_UPLOAD_PROVIDERS_FILE: credentialsFile,
        VIDEO_PIPELINE_NETWORK_UPLOADS: '1', VIDEO_SERVER_URL: `https://127.0.0.1:${catalog.address().port}`,
        DESCRIPTOR_MODEL_URL: `http://127.0.0.1:${model.address().port}`, DESCRIPTOR_MEDIA_PATH: path.join(dirs.data, 'descriptor-media'),
        NODE_OPTIONS: `--import ${pathToFileURL(path.join(ROOT, 'e2e', 'support', 'clock.mjs')).href} --no-warnings`,
    };
    const pipeline = (...args) => new Promise((resolve) => {
        clock.set(now);
        const child = spawn(process.execPath, [path.join(ROOT, 'packages/pipeline/dist/main.js'), ...args],
            { cwd: path.join(ROOT, 'packages/pipeline'), env: { ...env, E2E_NOW: String(now) }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('exit', (code) => {
            now += 1000;
            resolve({ code, stdout, stderr, json: () => { try { return JSON.parse(stdout); } catch { return JSON.parse(stdout.trim().split('\n').at(-1)); } } });
        });
    });
    const must = async (...args) => {
        const result = await pipeline(...args);
        if (result.code !== 0) throw new Error(`pipeline ${args.join(' ')} exited ${result.code}:\n${result.stderr.slice(-3000)}`);
        return result;
    };
    const ledger = (sql, ...params) => {
        const db = new DatabaseSync(ledgerPath, { readOnly: true });
        try { return db.prepare(sql).all(...params).map((row) => ({ ...row })); } finally { db.close(); }
    };
    const tick = async () => (await must('office-tick', '--apply')).json();
    const onDisk = (root) => existsSync(path.join(root, 'files')) ? readdirSync(path.join(root, 'files')).sort() : [];

    // ---- 1. conversion runs ahead of an allowance that sends nothing --------------------------

    say('converting ahead: home may send 1 byte a day');
    await must('campaign-configure', '--provider', 'all', '--daily-upload-bytes', '1', '--apply');
    await must('upload-provider', '--provider', DESTINATION, '--apply');
    await must('campaign-resume', '--apply');
    const ready = () => ledger("SELECT id FROM recordings WHERE state = 'metadata_ready'").length;
    const dispositions = [];
    for (let step = 0; step < 60 && ready() < names.length; step++) {
        const result = await pipeline('campaign-step', '--apply');
        dispositions.push(result.code === 0 ? result.json()?.step?.disposition ?? 'unknown' : `exit ${result.code}`);
        if (result.code !== 0) say(`step ${step}:\n${result.stderr.trim().slice(0, 1500)}`);
    }
    say(`steps: ${dispositions.join(', ')}`);
    check(ready() === names.length, `all five are converted and ready (${ready()})`);
    check(!dispositions.includes('upload_quota_wait') && created().length === 0, 'no step waited for allowance, and nothing was sent');
    const idle = (await must('campaign-step', '--apply')).json().step;
    check(idle.disposition === 'idle' && /allowance/.test(idle.uploads), `then the campaign idles, uploads waiting for home's allowance (${idle.uploads})`);

    // ---- 2. the carrier at home ---------------------------------------------------------------

    say('the drive at home: set up, two copies, a pull, the rest');
    mkdirSync(atHome);
    await must('carrier-init', '--apply');
    const first = (await must('carrier-pass', '--max-copies', '2', '--apply')).json();
    check(first.copied.length === 2, `two copies (${first.copied.length})`);
    // The drive was pulled during the third copy (a .partial is left), and a fourth file had
    // reached its name when the power went (no row).
    const artifacts = ledger('SELECT r.id, a.path, a.sha256 FROM recordings r JOIN artifacts a ON a.recording_id = r.id ORDER BY r.id');
    const later = artifacts.filter((artifact) => !first.copied.includes(path.basename(artifact.path)));
    writeFileSync(path.join(atHome, 'files', `${path.basename(later[0].path)}.partial`), readFileSync(later[0].path).subarray(0, 1000));
    writeFileSync(path.join(atHome, 'files', path.basename(later[1].path)), readFileSync(later[1].path));
    const second = (await must('carrier-pass', '--apply')).json();
    check(second.deleted.map((item) => item.why).sort().join(',') === 'an unfinished copy,not in the ledger', 'the next pass deletes the unfinished copy and the unrecorded file');
    check(second.copied.length === 3, `and copies the other three (${second.copied.length})`);
    const copied = ledger("SELECT file_name, sha256 FROM carrier_files WHERE state = 'copied'");
    check(copied.length === 5 && copied.every((row) => createHash('sha256').update(readFileSync(path.join(atHome, 'files', row.file_name))).digest('hex') === row.sha256),
        'five recorded copies on the drive, each the ledger\'s bytes');
    const home = await pipeline('upload-one', '--recording', names[0], '--apply');
    check(home.code !== 0 && /on carrier CARRIER1/.test(home.stderr), 'a file on the carrier never goes up from home');

    // ---- 3. the drive at the office -------------------------------------------------------------

    // The PC holds a signed-in shared session (in production the phone handoff makes it;
    // here the PC's own destination signs in once, in its state folder).
    const { destination: formHost } = await import(pathToFileURL(path.join(ROOT, 'plugins/form-host/dist/index.js')).href);
    const stateDir = path.join(dirs.data, 'pipeline', 'destinations', DESTINATION);
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    clock.set(now);
    await formHost.createDestination({ config: { baseUrl: sim.urls[DESTINATION], retryDelayMs: 100 }, stateDir,
        browser: { executablePath: '/unused', profilePath: '/unused' }, credentials: () => ({ email: 'coach', password: 'pw' }),
        stopSignal: new AbortController().signal }).withSession(async () => null);

    say('the drive goes to the office');
    renameSync(atHome, atOffice);
    await must('carrier-pass', '--apply');
    check(ledger("SELECT location FROM carrier_state")[0]?.location === 'away', 'the PC sees it gone');
    check((await tick()).action === 'awaiting_first_upload', 'the office lane waits for a person\'s first upload');
    writeFileSync(networkFile, 'home-net\n');
    const wrongNetwork = await pipeline('upload-one', '--recording', names[0], '--uplink', 'office', '--apply');
    check(wrongNetwork.code !== 0 && /on network home-net, not the uplink's/.test(wrongNetwork.stderr) && created().length === 0,
        'the runner on another network sends nothing');
    writeFileSync(networkFile, 'office-net\n');
    const supervised = (await must('upload-one', '--recording', names[0], '--uplink', 'office', '--apply')).json();
    check(supervised.uplink === 'office' && created().length === 1, 'the first upload from the office, by a person, is created');
    check(events('login').length === 1, 'the PC signed in once (its own shared session); the runner never signs in');

    writeFileSync(networkFile, 'home-net\n');
    check((await tick()).action === 'away', 'the office lane on another network: away, nothing sent');
    writeFileSync(networkFile, 'office-net\n');

    writeFileSync(killFile, 'file_uploading');
    const killedBefore = await tick();
    check(killedBefore.action === 'failed' && created().length === 1, `a runner killed before the creation boundary: a plain failure, nothing created`);
    const beforeId = killedBefore.recordingId;
    check(ledger('SELECT state FROM recordings WHERE id = ?', beforeId)[0].state === 'metadata_ready', 'its recording is ready again');
    check((await tick()).action === 'held', 'the office lane holds itself');
    now += 16 * 60_000;
    writeFileSync(killFile, 'result');
    const killedAfter = await tick();
    check(killedAfter.action === 'failed' && created().length === 2, 'a runner killed after the creation boundary: the video exists');
    check(ledger('SELECT state FROM recordings WHERE id = ?', killedAfter.recordingId)[0].state === 'upload_uncertain', 'its attempt is uncertain, to be confirmed, never sent again');
    now += 31 * 60_000;
    const sent = [];
    for (let i = 0; i < 10; i++) {
        const result = await tick();
        if (result.action === 'uploaded') sent.push(result.recordingId);
        else if (result.action === 'held') now += 61 * 60_000;
        else break;
    }
    check(sent.length === 3, `the office sends the remaining three (${sent.length})`);
    check((await tick()).action === 'done', 'nothing left: the drive is done');
    check(created().length === 5, `five videos created (${created().length})`);

    // ---- 4. verification, and the drive back home ------------------------------------------------

    say('a day later: verification');
    now += 25 * 3_600_000;
    await must('reconcile-uploads', '--apply');
    const verified = ledger('SELECT recording_id FROM remote_uploads').map((row) => row.recording_id).sort();
    check(JSON.stringify(verified) === JSON.stringify([...names].sort()), `all five verified online, the uncertain one found by its title (${verified.length})`);
    for (const name of names) check(created().filter((event) => event.title.endsWith(`[${name}]`)).length === 1, `"${name}": exactly one video`);

    say('the drive comes home and is cleaned');
    renameSync(atOffice, atHome);
    const cleaned = (await must('carrier-pass', '--apply')).json();
    check(cleaned.deleted.length === 5 && cleaned.deleted.every((item) => item.why === 'the site accepted it') && onDisk(atHome).length === 0,
        'every file the site accepted is deleted from the drive');
    check(ledger("SELECT count(*) AS n FROM carrier_files WHERE state = 'uploaded'")[0].n === 5, 'and settled as uploaded');
    const billed = Object.fromEntries(ledger('SELECT uplink, SUM(transmitted_bytes) AS bytes FROM bandwidth_events GROUP BY uplink').map((row) => [row.uplink, row.bytes]));
    check(billed.office > 0 && !billed.home, `every byte is billed to the office (${billed.office}), none to home`);
} catch (error) {
    failures.push(error.stack ?? String(error));
    console.error(error);
} finally {
    await cleanup();
}

if (KEEP) say(`kept ${runDir}`);
say(failures.length ? `${failures.length} failure(s)` : 'all assertions hold');
process.exit(failures.length ? 1 : 0);
