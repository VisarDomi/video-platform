#!/usr/bin/env node
// End-to-end: the real file-host service (packages/server/dist/fileHosts.js) copies files
// from the simulated file host through the public plug-in, over HTTPS on the simulator's
// own ports, and every published file is compared with the bytes the host served.
//
//   npm run build:server && npm run build -w simulator && npm run build -w plugin-file-host
//   npm run e2e:file-host          (about a minute; E2E_KEEP=1 keeps everything)
//
// 1. Tiny generated media, prepared once; a throwaway certificate for 127.0.0.1, which the
//    simulator serves with and the service trusts (NODE_EXTRA_CA_CERTS).
// 2. The simulator in this process, real clock: four files behind a download button, a
//    link API that wants the page as referer, signed URLs that hop between the two hosts
//    twice, and faults: a first window in which the download host redirects off-site (to
//    the cloud metadata address), then one transfer that stops after 1 MiB and is dropped
//    two seconds later, and one slow enough to kill the service in the middle of it.
// 3. A sites file whose file host entry allows exactly the simulator's two ports
//    ("allowPorts"), and the service as a child process whose every path points into the
//    run directory. The run enqueues each page as the browser extension would.
// 4. The off-site redirect is refused and nothing is published; the file comes once the
//    window is over. The dropped transfer resumes with a range request; the service is killed
//    (SIGKILL) during the slow one and started again, and that transfer resumes from its
//    durable bytes. Every published file must be byte-identical to the host's.
//
// Exit status: 0 when every assertion holds, 1 otherwise, 2 when the run could not happen.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const need = ['packages/server/dist/fileHosts.js', 'packages/simulator/dist/index.js', 'plugins/file-host/dist/index.js'];
for (const file of need) {
    if (!existsSync(path.join(ROOT, file))) {
        console.error(`missing ${file}: build first (npm run build:server && npm run build -w simulator && npm run build -w plugin-file-host)`);
        process.exit(2);
    }
}
const { startSimulator, prepAll, readTruthSet } = await import(path.join(ROOT, 'packages/simulator/dist/index.js'));

const started = Date.now();
const say = (message) => console.log(`[e2e ${((Date.now() - started) / 1000).toFixed(0)}s] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- isolation -----------------------------------------------------------------------

const runDir = mkdtempSync(path.join(os.tmpdir(), 'file-host-e2e-'));
const dirs = {
    home: path.join(runDir, 'home'), data: path.join(runDir, 'data'), library: path.join(runDir, 'library'),
    sim: path.join(runDir, 'sim-state'), media: path.join(runDir, 'media'), tls: path.join(runDir, 'tls'),
};
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
const sitesFile = path.join(dirs.data, 'sites.json');
const production = [path.join(os.homedir(), '.local', 'share', 'video-services'), path.join(os.homedir(), 'Videos')];
const inside = (parent, child) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
for (const dir of [...Object.values(dirs), sitesFile]) {
    if (!inside(runDir, dir) || production.some((p) => inside(p, dir) || inside(dir, p))) {
        console.error(`isolation guard: ${dir} is not a private run path`);
        process.exit(2);
    }
}

// ---- certificate, media, scenario ------------------------------------------------------

const cert = path.join(dirs.tls, 'cert.pem');
const key = path.join(dirs.tls, 'key.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-keyout', key, '-out', cert], { stdio: 'ignore' });
// The service serves its own API with the deployment's certificate, under its HOME.
const serviceCerts = path.join(dirs.home, '.local', 'share', 'mkcert', 'pwa');
mkdirSync(serviceCerts, { recursive: true });
writeFileSync(path.join(serviceCerts, 'cert.pem'), readFileSync(cert));
writeFileSync(path.join(serviceCerts, 'key.pem'), readFileSync(key));

async function prepareMedia() {
    const input = path.join(dirs.media, 'in');
    mkdirSync(input, { recursive: true });
    execFileSync('nice', ['-n', '19', 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-threads', '2', '-c:a', 'aac', '-b:a', '64k',
        path.join(input, 'Final.mkv')]);
    const cache = path.join(dirs.media, 'cache');
    await prepAll({ input, out: cache });
    return cache;
}

// What happens to each file (seconds from the scenario's epoch).
const FILES = [
    { id: 'quarter', name: 'Quarter-final.mp4', kind: 'offsite-then-complete' },
    { id: 'final-centre', name: 'Final, centre court.mp4', kind: 'healthy' },
    { id: 'semi-one', name: 'Semi-final one.mp4', kind: 'dropped-resume' },
    { id: 'semi-two', name: 'Semi-final two.mp4', kind: 'killed-resume' },
];
const OFFSITE = { from: 0, until: 8 };
const DROP = { from: 8, until: 20 };
const SLOW_BYTES_PER_S = 160 * 1024;

function scenario(epoch) {
    return {
        name: 'file host e2e', seed: 'file-host-e2e-1', epoch,
        sites: { 'file-host': {
            files: FILES.map(({ id, name }) => ({ id, name })),
            albums: [],
            signatureTtlS: 60,
            redirectHops: 2,
            requireReferer: true,
            faults: [
                { type: 'offsiteRedirect', url: 'https://169.254.169.254/latest/meta-data/', at: OFFSITE.from, until: OFFSITE.until },
                // A reset ("cut") can lose bytes the client had not read yet; a stall delivers
                // them first, so the client has durable bytes to resume from.
                { type: 'transferStall', mode: 'stall', afterBytes: 1048576, stallS: 2, file: 'semi-one', at: DROP.from, until: DROP.until },
                { type: 'transferStall', mode: 'slow', afterBytes: 0, bytesPerSecond: SLOW_BYTES_PER_S, file: 'semi-two', at: 0, until: 600 },
            ],
        } },
    };
}

// ---- the service -----------------------------------------------------------------------

const freePort = () => new Promise((resolve, reject) => {
    const server = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(port));
    });
});

let sim = null;
let service = null;
const serviceLines = [];
const logFile = path.join(runDir, 'file-hosts.log');
const logStream = createWriteStream(logFile);
let servicePort = 0;

function startService() {
    const env = {
        PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: dirs.home,
        XDG_DATA_HOME: path.join(dirs.home, '.local', 'share'), XDG_CONFIG_HOME: path.join(dirs.home, '.config'),
        VIDEO_SERVICES_DATA_ROOT: dirs.data, VIDEO_SITES_FILE: sitesFile, VIDEO_FILE_HOSTS_PORT: String(servicePort),
        NODE_EXTRA_CA_CERTS: cert,
    };
    const proc = spawn(process.execPath, [path.join(ROOT, 'packages/server/dist/fileHosts.js')], { cwd: runDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const onData = (chunk) => { logStream.write(chunk); serviceLines.push(...chunk.toString().split('\n').filter(Boolean)); };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.exited = new Promise((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })));
    return proc;
}

// The service's API, as the browser extension's background page calls it.
function api(method, route, body) {
    return new Promise((resolve, reject) => {
        const request = https.request({ host: '127.0.0.1', port: servicePort, path: route, method, ca: readFileSync(cert),
            headers: { 'content-type': 'application/json', 'X-Video-Download': '1' } }, (response) => {
            let text = '';
            response.on('data', (chunk) => { text += chunk; });
            response.on('end', () => { try { resolve({ status: response.statusCode, body: JSON.parse(text) }); } catch { resolve({ status: response.statusCode, body: text }); } });
        });
        request.on('error', reject);
        request.end(body === undefined ? undefined : JSON.stringify(body));
    });
}

async function waitFor(what, check, timeoutMs) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const value = await check().catch(() => null);
        if (value) return value;
        if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
        await sleep(250);
    }
}

const job = async (id) => (await api('GET', `/api/file-host/downloads/${id}`)).body;

// ---- the run -------------------------------------------------------------------------

async function run() {
    say(`run directory ${runDir}`);
    const cache = await prepareMedia();
    say('media prepared');
    const epoch = Math.ceil((Date.now() + 1500) / 1000) * 1000;
    sim = await startSimulator({ scenario: scenario(epoch), media: cache, stateDir: dirs.sim, host: '127.0.0.1', ports: {}, clockMode: 'real', tls: { cert, key } });
    const origin = sim.urls['file-host'];
    const cdn = sim.urls['file-host-cdn'];
    say(`simulator up: file host ${origin}, download host ${cdn}`);
    const ports = [Number(new URL(origin).port), Number(new URL(cdn).port)];
    writeFileSync(sitesFile, JSON.stringify({ sites: [], fileHosts: [{ id: 'file-host', plugin: 'plugin-file-host', allowPorts: ports,
        config: { origin, downloadHosts: ['127.0.0.1'], directory: dirs.library } }] }, null, 2));

    servicePort = await freePort();
    service = startService();
    await waitFor('the service', async () => (await api('GET', '/api/file-host/health')).status === 200, 20_000);
    say(`service up on :${servicePort}`);

    const jobs = {};
    // An address that is not one of the host's file pages is refused before anything runs.
    const refused = await api('POST', '/api/file-host/downloads', { url: origin.replace(/:\d+$/, ':1') + '/f/final-centre' });

    // Inside the off-site window (the files appear at the epoch): the download host
    // redirects to the metadata address.
    await waitFor('the scenario to start', async () => Date.now() >= epoch + 250, 10_000);
    const enqueued = await api('POST', '/api/file-host/downloads', { url: `${origin}/f/quarter` });
    jobs.quarter = enqueued.body.id;
    const offsite = await waitFor('the off-site attempt', async () => {
        const current = await job(jobs.quarter);
        return current.attempts >= 1 && current.state !== 'downloading' && current.error ? current : null;
    }, 20_000);
    const publishedDuringOffsite = readdirSync(dirs.library).filter((name) => name.includes('Quarter'));
    say(`quarter, first attempt: ${offsite.state}, ${offsite.error}`);
    await waitFor('the end of the off-site window', async () => Date.now() >= epoch + OFFSITE.until * 1000 + 250, 20_000);

    for (const file of FILES.filter((f) => f.id !== 'quarter')) {
        const answer = await api('POST', '/api/file-host/downloads', { url: `${origin}/f/${file.id}` });
        if (answer.status !== 202) throw new Error(`enqueue ${file.id}: ${answer.status} ${JSON.stringify(answer.body)}`);
        jobs[file.id] = answer.body.id;
    }

    // The slow transfer: once some of it is durable, the service dies and starts again.
    const killedAt = await waitFor('the slow transfer to be under way', async () => {
        const current = await job(jobs['semi-two']);
        return current.state === 'downloading' && (current.durableBytes ?? 0) > 0 ? current : null;
    }, 60_000);
    service.kill('SIGKILL');
    await service.exited;
    say(`service killed during the slow transfer (${killedAt.durableBytes} durable bytes of ${killedAt.total})`);
    service = startService();
    await waitFor('the service again', async () => (await api('GET', '/api/file-host/health')).status === 200, 20_000);
    say('service started again');

    const finished = {};
    for (const file of FILES) {
        finished[file.id] = await waitFor(`${file.id} to complete`, async () => {
            const current = await job(jobs[file.id]);
            return current.state === 'complete' || current.state === 'failed' ? current : null;
        }, 150_000);
        say(`${file.id}: ${finished[file.id].state} after ${finished[file.id].attempts} attempt(s)`);
    }

    service.kill('SIGTERM');
    const stop = await Promise.race([service.exited, sleep(30_000).then(() => null)]);
    if (!stop) service.kill('SIGKILL');
    await new Promise((resolve) => logStream.end(resolve));
    await sim.close();
    sim = null;
    return { refused, offsite, publishedDuringOffsite, jobs, finished, killedAt, stop };
}

// ---- judging -------------------------------------------------------------------------

function judge({ refused, offsite, publishedDuringOffsite, finished, killedAt, stop }) {
    const failures = [];
    const rows = [];
    const expect = (ok, what, message) => { if (!ok) failures.push(`${what}: ${message}`); return ok; };
    const records = readTruthSet(dirs.sim);
    const served = new Map(records.filter((r) => r.type === 'event' && r.event === 'file').map((r) => [r.file, r]));
    const allDownloads = records.filter((r) => r.type === 'response' && r.kind === 'download');
    const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

    expect(stop?.code === 0 || stop?.signal === 'SIGTERM', 'service', `stop ${JSON.stringify(stop)}`);
    expect(refused.status === 400, 'service', `a page on another port was answered ${refused.status}`);
    for (const file of FILES) {
        const result = finished[file.id];
        const truth = served.get(file.id);
        const row = { file: file.id, kind: file.kind, state: result?.state, attempts: result?.attempts, bytes: result?.bytes, note: '' };
        rows.push(row);
        if (!expect(truth, file.id, 'the host logged no such file')) continue;
        const ranges = allDownloads.filter((r) => r.path.includes(`/dl/${file.id}/`) && r.status === 206);
        if (!expect(result.state === 'complete', file.id, `${result.state}: ${result.error ?? ''}`)) continue;
        const published = path.join(dirs.library, result.filename);
        const same = existsSync(published) && sha256(published) === truth.sha256;
        expect(same, file.id, `the published file differs from the ${truth.bytes} bytes the host served`);
        expect(result.bytes === truth.bytes, file.id, `${result.bytes} bytes recorded, ${truth.bytes} served`);
        row.note = same ? 'byte-identical' : 'DIFFERS';
        if (file.kind === 'offsite-then-complete') {
            expect(offsite.state === 'queued' && /Unsupported/.test(offsite.error ?? ''), file.id, `first attempt ${offsite.state}: ${offsite.error}`);
            expect(publishedDuringOffsite.length === 0, file.id, `published during the off-site window: ${publishedDuringOffsite.join(', ')}`);
            expect(result.attempts >= 2, file.id, `${result.attempts} attempt(s)`);
            row.note += ', first attempt refused (off-site redirect)';
        }
        if (file.kind === 'healthy') expect(result.attempts === 1 && ranges.length === 0, file.id, `${result.attempts} attempts, ${ranges.length} range requests`);
        if (file.kind === 'dropped-resume') {
            expect(result.attempts >= 2 && ranges.length >= 1, file.id, `${result.attempts} attempts, ${ranges.length} range requests`);
            row.note += `, resumed ${ranges.length}x`;
        }
        if (file.kind === 'killed-resume') {
            expect(ranges.length >= 1, file.id, 'no range request after the restart');
            row.note += `, killed at ${killedAt.durableBytes} durable bytes, resumed`;
        }
    }
    return { failures, rows };
}

let exitCode = 2;
try {
    const outcome = await run();
    const { failures, rows } = judge(outcome);
    const text = [
        `# File host e2e: ${failures.length ? 'FAIL' : 'PASS'}`, '',
        `Run ${runDir}, ${Math.round((Date.now() - started) / 1000)} s. Service log: ${logFile}.`, '',
        '| File | Case | State | Attempts | Bytes | Check |', '|---|---|---|---|---|---|',
        ...rows.map((r) => `| ${r.file} | ${r.kind} | ${r.state} | ${r.attempts} | ${r.bytes} | ${r.note} |`), '',
        failures.length ? `Failures:\n${failures.map((f) => `- ${f}`).join('\n')}` : 'All assertions hold.', '',
    ].join('\n');
    writeFileSync(path.join(runDir, 'report.md'), text);
    console.log('\n' + text);
    exitCode = failures.length ? 1 : 0;
    if (exitCode === 0 && process.env.E2E_KEEP !== '1') {
        for (const dir of [dirs.media, dirs.library, dirs.sim, dirs.home, dirs.tls]) rmSync(dir, { recursive: true, force: true });
    }
} catch (error) {
    console.error(`[e2e] ${error?.stack ?? error}`);
    if (service && service.exitCode === null) service.kill('SIGKILL');
    if (sim) await sim.close().catch(() => {});
}
process.exit(exitCode);
