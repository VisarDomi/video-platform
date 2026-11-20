#!/usr/bin/env node
// End-to-end: the real pipeline (packages/pipeline/dist/main.js, as child processes)
// takes finalized recordings of a simulated live site through discovery, conversion,
// description and upload to the simulated form host (through the public plugin-form-host),
// then verifies them a day later, and holds a copy the host removed at the seven-day gate.
//
//   npm run build:pipeline && npm run build -w simulator && npm run build -w plugin-form-host
//   npm run e2e:pipeline           (a few minutes; E2E_KEEP=1 keeps everything)
//
// 1. Three finalized recordings of "live-a" (generated 1080p HLS, ffmpeg under nice), and
//    their finalization checkpoints, in a temporary downloads root and data root.
// 2. The simulator in this process: the form host only, a manual clock, a refused word.
// 3. Stand-ins for the other services: a model server (the descriptor's OpenAI-style
//    endpoint) whose first description carries the refused word, and the server's
//    resolve route over HTTPS (a self-signed certificate made now).
// 4. The pipeline's clock is the run's simulated time (e2e/support/clock.mjs), so a day
//    passes between two commands; the simulator's clock is set to the same time.
// 5. The run: configure, choose the destination, resume, campaign steps until every
//    recording is submitted (a forced logout on the way); the host removes one; a day
//    later reconcile verifies the other two and holds the removed one at the seven-day
//    gate (its ID was captured at submission, so it counts as accepted), and a retry of
//    it uploads nothing.
//
// Exit status: 0 when every assertion holds, 1 otherwise, 2 when the run could not
// happen (missing build, isolation guard).
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = process.env.E2E_KEEP === '1';

const need = ['packages/pipeline/dist/main.js', 'packages/simulator/dist/index.js', 'packages/sdk/dist/index.js', 'plugins/form-host/dist/index.js'];
for (const file of need) {
    if (!existsSync(path.join(ROOT, file))) {
        console.error(`missing ${file}: build first (npm run build:pipeline && npm run build -w simulator && npm run build -w plugin-form-host)`);
        process.exit(2);
    }
}
const { startSimulator, MediaLibrary, SimClock, prepAll } = await import(path.join(ROOT, 'packages/simulator/dist/index.js'));
const { fixturePart, assemble } = await import(path.join(ROOT, 'packages/pipeline/test/helpers/mediaFixture.mjs'));

const started = Date.now();
const say = (message) => console.log(`[e2e ${((Date.now() - started) / 1000).toFixed(0)}s] ${message}`);

// ---- isolation -----------------------------------------------------------------------

const runDir = mkdtempSync(path.join(os.tmpdir(), 'pipeline-e2e-'));
const dirs = Object.fromEntries(['home', 'data', 'downloads', 'media', 'scratch', 'tls'].map((name) => [name, path.join(runDir, name)]));
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
const inside = (parent, child) => { const relative = path.relative(parent, child); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); };
const production = [path.join(os.homedir(), '.local', 'share', 'video-services'), path.join(os.homedir(), '.config', 'video-services')];

const SITE = 'live-a';
const EPOCH = Date.parse('2026-06-01T00:00:00.000Z');
const ledgerPath = path.join(dirs.data, 'pipeline', 'pipeline.sqlite');
const finalizationPath = path.join(dirs.data, 'finalization.sqlite');
const sitesFile = path.join(dirs.data, 'sites.json');
const credentialsFile = path.join(dirs.data, 'upload-providers.json');
for (const file of [ledgerPath, finalizationPath, sitesFile, credentialsFile, dirs.downloads]) {
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
    // ---- 1. finalized recordings ---------------------------------------------------------

    say('generating three finalized 1080p recordings');
    const names = ['2026-06-01 080000 court-one', '2026-06-01 090000 court-two', '2026-06-01 100000 court-three'];
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

    // ---- 2. the simulator ----------------------------------------------------------------

    say('starting the simulator (form host)');
    mkdirSync(path.join(dirs.media, 'in'), { recursive: true });
    execFileSync('nice', ['-n', '19', 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
        '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', path.join(dirs.media, 'in', 'Practice.mkv')]);
    await prepAll({ input: path.join(dirs.media, 'in'), out: path.join(dirs.media, 'cache') });
    const clock = new SimClock({ mode: 'manual', at: EPOCH + 3_600_000 * 11 });
    sim = await startSimulator({
        scenario: { name: 'pipeline e2e', seed: 'pipeline-e2e', epoch: EPOCH, sites: { 'form-host': {
            accounts: [{ username: 'coach', password: 'pw', displayName: 'Coach' }],
            chunkSize: 1 << 20, processingS: 120, bannedWords: [{ word: 'forbidden', action: 'refuse' }],
        } } },
        media: MediaLibrary.load(path.join(dirs.media, 'cache')), clock, autoPublish: false, memoryTruth: true, host: '127.0.0.1',
    });
    const formHost = sim.urls['form-host'];
    const control = (action, body = {}) => fetch(`${sim.urls.control}/sites/form-host/${action}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const events = (name) => sim.memory.records.filter((r) => r.type === 'event' && r.site === 'form-host' && r.event === name);

    // ---- 3. stand-ins ---------------------------------------------------------------------

    let descriptions = 0, rewrites = 0;
    model = createHttpServer(async (req, res) => {
        if (req.url === '/health') return res.end('{"status":"ok"}');
        let body = '';
        for await (const chunk of req) body += chunk;
        const prompt = JSON.stringify(JSON.parse(body).messages);
        const rewrite = prompt.includes('Rewrite this video title');
        rewrite ? rewrites++ : descriptions++;
        // The first description carries the host's refused word; the rewrite drops it.
        const text = !rewrite && descriptions === 1
            ? { title: 'A forbidden rally on centre court', description: 'Two players trade long rallies from the baseline until the last point.' }
            : { title: `Baseline rallies, match ${descriptions}`, description: 'Two players trade long rallies from the baseline until the last point.' };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(text) } }] }));
    });
    await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));

    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
        '-keyout', path.join(dirs.tls, 'key.pem'), '-out', path.join(dirs.tls, 'cert.pem')], { stdio: 'ignore' });
    const resolves = [];
    catalog = createHttpsServer({ key: readFileSync(path.join(dirs.tls, 'key.pem')), cert: readFileSync(path.join(dirs.tls, 'cert.pem')) }, (req, res) => {
        const url = new URL(req.url, 'https://127.0.0.1');
        const identifier = url.searchParams.get('identifier');
        resolves.push(`${url.pathname} ${identifier}`);
        if (url.pathname !== `/api/${SITE}/resolve` || !identifier) { res.statusCode = 404; return res.end('{}'); }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: `id-${identifier}`, label: identifier, channelUrl: `https://${SITE}.test/id-${identifier}`, aliasUrl: `https://${SITE}.test/@${identifier}` }));
    });
    await new Promise((resolve) => catalog.listen(0, '127.0.0.1', resolve));

    // ---- 4. configuration ----------------------------------------------------------------

    writeFileSync(sitesFile, JSON.stringify({
        contentProfile: pathToFileURL(path.join(ROOT, 'e2e', 'support', 'profile.mjs')).href,
        destinations: [{ id: 'form-host', plugin: 'plugin-form-host', config: { baseUrl: formHost, retryDelayMs: 100 } }],
        sites: [{ id: SITE, plugin: 'plugin-ts-live' }],
    }, null, 2));
    writeFileSync(credentialsFile, JSON.stringify({ version: 1, providers: { 'form-host': { username: 'coach', password: 'pw' } } }), { mode: 0o600 });

    let now = EPOCH + 3_600_000 * 11; // 11:00, the day of the recordings
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

    // ---- 5. the run -----------------------------------------------------------------------

    say('configuring the campaign and its destination');
    await must('campaign-configure', '--provider', 'all', '--apply');
    await must('upload-provider', '--provider', 'form-host', '--apply');
    await must('campaign-resume', '--apply');

    say('campaign steps until every recording is submitted');
    const submitted = () => ledger("SELECT DISTINCT recording_id FROM upload_attempts WHERE status = 'uncertain' AND phase = 'metadata_submitting'").length;
    let loggedOut = false;
    const dispositions = [];
    for (let step = 0; step < 60 && submitted() < names.length; step++) {
        const result = await pipeline('campaign-step', '--apply');
        const disposition = result.code === 0 ? result.json()?.step?.disposition ?? 'unknown' : `exit ${result.code}`;
        dispositions.push(disposition);
        if (result.code !== 0) say(`step ${step}:\n${result.stderr.trim().slice(0, 1500)}`);
        if (!loggedOut && submitted() === 1) {
            // Every session of the account ends, remember-me too: the next upload signs in again.
            await control('logout', { account: 'coach', revokeRemember: true });
            loggedOut = true;
        }
    }
    say(`steps: ${dispositions.join(', ')}`);
    check(submitted() === names.length, `every recording is submitted (${submitted()} of ${names.length})`);
    const created = events('video-created');
    check(created.length === names.length, `the host created exactly ${names.length} videos (${created.length})`);
    for (const name of names) {
        check(created.filter((event) => event.title.endsWith(`[${name}]`)).length === 1, `"${name}": one video, its title stamped with the recording`);
    }
    check(events('metadata-refused').length === 1, 'the refused word was refused once');
    check(rewrites >= 1 && !created.some((event) => /forbidden/i.test(event.title)), 'the description was rewritten without it');
    check(ledger("SELECT phrase FROM rejected_phrases WHERE provider = 'form-host'").some((row) => row.phrase === 'forbidden'), 'the refused word is learned for form-host');
    check(events('login').filter((event) => event.via === 'password').length === 2, 'one password login, then one more after the forced logout');
    check(resolves.length >= names.length && resolves.every((line) => line.startsWith(`/api/${SITE}/resolve`)), 'provenance came from the server\'s resolve route');
    const descriptionsSent = ledger('SELECT description FROM upload_metadata').map((row) => row.description);
    check(descriptionsSent.length === names.length && descriptionsSent.every((text) => text.includes(`Source: https://${SITE}.test/id-`)), 'every description names its source page from the catalog');

    say('the host removes one before verification; a day later reconcile verifies the others');
    const removedName = names[2];
    const removedId = created.find((event) => event.title.endsWith(`[${removedName}]`)).video;
    await control('remove', { id: removedId, reason: 'rule' });
    now += 25 * 3_600_000;
    const reconciled = await must('reconcile-uploads', '--apply');
    const results = reconciled.json().results.map(({ recordingId, disposition }) => `${recordingId.slice(-11)}: ${disposition}`);
    say(`reconcile: ${results.join(', ')}`);
    const verified = ledger('SELECT recording_id FROM remote_uploads').map((row) => row.recording_id).sort();
    check(JSON.stringify(verified) === JSON.stringify(names.slice(0, 2)), `the two others are verified online (${verified.length})`);
    // The removed video's ID was captured at submission (an accepted upload): the core
    // waits for the seven-day gate before it decides anything about a missing accepted copy.
    check(reconciled.json().results.some((r) => r.recordingId === removedName && r.disposition === 'not_ready'),
        'the removed, accepted upload waits for the seven-day gate');
    check(ledger('SELECT 1 FROM provider_removals').length === 0 && ledger("SELECT 1 FROM remote_uploads WHERE recording_id = ?", removedName).length === 0,
        'nothing is decided about it yet: not verified, not recorded as removed');
    const retried = await pipeline('retry', removedName, '--apply');
    say(`retry: exit ${retried.code}: ${(retried.stderr || retried.stdout).trim().split('\n')[0].slice(0, 200)}`);
    for (let step = 0; step < 5; step++) await pipeline('campaign-step', '--apply');
    check(retried.code !== 0 && events('video-created').length === names.length, 'a retry refuses it while it is unresolved, and nothing is uploaded again');
    const bandwidth = ledger("SELECT COALESCE(SUM(transmitted_bytes), 0) AS bytes FROM bandwidth_events WHERE provider = 'form-host'")[0].bytes;
    check(bandwidth > 0, `bytes sent are billed to form-host (${bandwidth})`);
} catch (error) {
    failures.push(error.stack ?? String(error));
    console.error(error);
} finally {
    await cleanup();
}

if (KEEP) say(`kept ${runDir}`);
say(failures.length ? `${failures.length} failure(s)` : 'all assertions hold');
process.exit(failures.length ? 1 : 0);
