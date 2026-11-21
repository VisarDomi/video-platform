#!/usr/bin/env node
// The demo: the whole platform against the simulator, in one process tree. It runs as the
// entrypoint of the demo image (deploy/demo/Containerfile), where every service keeps its
// own ports and paths inside the pod, and everything it keeps lives under $HOME (the pod's
// volume): media, certificates, configuration, recordings, the ledger.
//
// 1. Media: the videos in $DEMO_MEDIA_INPUT (mounted, e.g. a folder of tennis matches) or,
//    without any, three generated test patterns; prepared once for the simulator.
// 2. A certificate for the pod's HTTPS (127.0.0.1, localhost and $DEMO_CERT_HOSTS, e.g. the
//    PC's LAN address for a phone), made once; or one mounted at ~/.local/share/mkcert/pwa.
// 3. The simulator (packages/simulator/scenarios/demo.json, real clock): three live sites,
//    a file host and two upload destinations, all over HTTPS.
// 4. The sites file, the accounts files and the download lists, written for it (the lists
//    only when missing: edits made through the website stay).
// 5. The services, each restarted when it exits: the auth daemon, the downloader, the
//    server (website and API on 9999), the file-host queue (9998), the dashboard (8791),
//    and the pipeline's campaign worker, uploading to the form host. Its description model
//    is a stand-in that answers in the descriptor's format ($DEMO_MODEL_URL: a real one).
//
// SIGTERM stops the services (the worker first, the simulator last) and exits.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOME = os.homedir();
const DATA = path.join(HOME, '.local', 'share', 'video-services');
const CERTS = path.join(HOME, '.local', 'share', 'mkcert', 'pwa');
const DEMO = path.join(HOME, 'demo');
const SCENARIO = path.join(ROOT, 'packages', 'simulator', 'scenarios', 'demo.json');
const MODEL_PORT = 18090;
const DESTINATION = process.env.DEMO_DESTINATION ?? 'form-host';

const say = (message) => console.log(`[demo] ${message}`);

function writeAtomically(file, text, mode = 0o644) {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}`;
    writeFileSync(temporary, text, { mode });
    renameSync(temporary, file);
}

// ---- 1. media ----------------------------------------------------------------------------

async function prepareMedia() {
    const cache = path.join(DEMO, 'media-cache');
    if (existsSync(cache) && readdirSync(cache).some((name) => existsSync(path.join(cache, name, 'manifest.json')))) return cache;
    const mounted = process.env.DEMO_MEDIA_INPUT;
    const videos = /\.(mp4|mkv|mov|webm)$/i;
    let input = mounted && existsSync(mounted) && readdirSync(mounted).some((name) => videos.test(name)) ? mounted : null;
    if (!input) {
        input = path.join(DEMO, 'generated-media');
        mkdirSync(input, { recursive: true });
        for (const [name, frequency] of [['Centre court rally.mkv', 440], ['Clay court rally.mkv', 550], ['Hard court rally.mkv', 660]]) {
            const file = path.join(input, name);
            if (existsSync(file)) continue;
            say(`generating ${name}`);
            execFileSync('nice', ['-n', '19', 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
                '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000`,
                '-t', '60', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '50', '-threads', '2', '-c:a', 'aac', '-b:a', '96k', `${file}.part.mkv`]);
            renameSync(`${file}.part.mkv`, file);
        }
    }
    say(`preparing the simulator's media from ${input} (once)`);
    const { prepAll } = await import(path.join(ROOT, 'packages', 'simulator', 'dist', 'index.js'));
    await prepAll({ input, out: cache });
    return cache;
}

// ---- 2. certificate ------------------------------------------------------------------------

function certificate() {
    const cert = path.join(CERTS, 'cert.pem');
    const key = path.join(CERTS, 'key.pem');
    if (existsSync(cert) && existsSync(key)) return { cert, key };
    mkdirSync(CERTS, { recursive: true });
    const hosts = (process.env.DEMO_CERT_HOSTS ?? '').split(',').map((host) => host.trim()).filter(Boolean);
    const names = ['IP:127.0.0.1', 'DNS:localhost', ...hosts.map((host) => (/^[\d.]+$|:/.test(host) ? `IP:${host}` : `DNS:${host}`))];
    say(`making the demo's certificate for ${names.join(', ')}`);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '825',
        '-subj', '/CN=video-platform demo', '-addext', `subjectAltName=${names.join(',')}`, '-addext', 'basicConstraints=critical,CA:TRUE',
        '-keyout', `${key}.tmp`, '-out', `${cert}.tmp`], { stdio: 'ignore' });
    renameSync(`${key}.tmp`, key);
    renameSync(`${cert}.tmp`, cert);
    return { cert, key };
}

// ---- 5. services ---------------------------------------------------------------------------

const services = new Map();
let stopping = false;

// What the dashboard shows for the services (it reads systemd's view elsewhere): each
// one's state, restarts and uptime under its unit name, and the worker's latest step.
const STATUS_FILE = path.join(DEMO, 'services.json');
const UNIT_NAMES = { auth: 'video-auth', downloader: 'video-downloader', server: 'video-server', pipeline: 'video-pipeline', 'file-hosts': 'video-file-hosts' };
let workerStep = null;

function writeStatus() {
    const now = Date.now();
    const report = { written_at: now / 1000, worker_step: workerStep, services: {} };
    for (const service of services.values()) {
        const unit = UNIT_NAMES[service.name];
        if (!unit) continue;
        report.services[unit] = { state: service.state, restarts: service.restartCount,
            uptime_seconds: service.state === 'active' && service.startedAt ? Math.round((now - service.startedAt) / 1000) : null };
    }
    try { writeAtomically(STATUS_FILE, JSON.stringify(report) + '\n'); } catch (error) { say(`status file: ${error.message}`); }
}
setInterval(writeStatus, 10_000).unref();

function start(name, command, args, { env = {}, cwd = ROOT, onLine, final = [] } = {}) {
    const service = { name, command, args, env, cwd, onLine, final, child: null, restarts: [], restartCount: 0, exited: null, state: 'activating', startedAt: null };
    services.set(name, service);
    run(service);
    return service;
}

function run(service) {
    const child = spawn(service.command, service.args, {
        cwd: service.cwd, env: { ...baseEnv(), ...service.env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    service.child = child;
    service.state = 'active';
    service.startedAt = Date.now();
    writeStatus();
    service.exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    let partial = '';
    const onData = (chunk) => {
        partial += chunk.toString();
        const lines = partial.split('\n');
        partial = lines.pop();
        for (const line of lines) {
            process.stdout.write(`[${service.name}] ${line}\n`);
            service.onLine?.(line);
        }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    service.exited.then(({ code, signal }) => {
        service.startedAt = null;
        if (stopping) { service.state = 'inactive'; return; }
        if (service.final.includes(code)) {
            service.state = 'failed';
            writeStatus();
            say(`${service.name} exited ${code}: not restarted`);
            return;
        }
        service.state = 'activating';
        service.restartCount++;
        writeStatus();
        // Restart after 5 s, after a minute once it has failed five times in two minutes.
        const now = Date.now();
        service.restarts = [...service.restarts.filter((at) => now - at < 120_000), now];
        const wait = service.restarts.length > 5 ? 60_000 : 5_000;
        say(`${service.name} exited (${signal ?? code}); restarting in ${wait / 1000} s`);
        setTimeout(() => { if (!stopping) run(service); }, wait).unref();
    });
}

function baseEnv() {
    return {
        PATH: process.env.PATH, HOME, LANG: 'C.UTF-8', TZ: process.env.TZ ?? 'UTC', LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
        NODE_EXTRA_CA_CERTS: path.join(CERTS, 'cert.pem'),
        NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
    };
}

async function stopAll() {
    if (stopping) return;
    stopping = true;
    say('stopping');
    // The worker first (it finishes or abandons its step safely), the simulator last.
    for (const name of ['pipeline', 'downloader', 'file-hosts', 'dashboard', 'server', 'auth', 'simulator']) {
        const service = services.get(name);
        if (!service?.child || service.child.exitCode !== null || service.child.signalCode !== null) continue;
        service.child.kill('SIGTERM');
        const stopped = await Promise.race([service.exited, new Promise((resolve) => setTimeout(() => resolve(null), 25_000))]);
        if (!stopped) service.child.kill('SIGKILL');
    }
    process.exit(0);
}
process.on('SIGTERM', stopAll);
process.on('SIGINT', stopAll);

// The description model's stand-in: the descriptor's OpenAI-style requests, answered with
// a plain title and description (a rewrite request gets a fresh title).
function modelStandIn() {
    const shots = ['Long baseline rally', 'Serve and volley exchange', 'Drop shot at the net', 'Cross-court forehands', 'Break point rally'];
    const server = createServer(async (request, response) => {
        if (request.url === '/health') return response.end('{"status":"ok"}');
        let body = '';
        for await (const chunk of request) body += chunk;
        const digest = createHash('sha256').update(body).digest();
        const shot = shots[digest[0] % shots.length];
        const text = { title: `${shot}, practice match`, description: `${shot} between two players, followed by a short break and another point from the baseline.` };
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(text) } }] }));
    });
    return new Promise((resolve) => server.listen(MODEL_PORT, '127.0.0.1', () => resolve(`http://127.0.0.1:${MODEL_PORT}`)));
}

// ---- 3. and 4. the simulator and the configuration ------------------------------------------

function waitForLine(service, pattern, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${service.name}: no "${pattern}" within ${timeoutMs / 1000} s`)), timeoutMs);
        const previous = service.onLine;
        service.onLine = (line) => {
            previous?.(line);
            const match = line.match(pattern);
            if (match) { clearTimeout(timer); service.onLine = previous; resolve(match); }
        };
    });
}

function configure(urls) {
    const scenario = JSON.parse(readFileSync(SCENARIO, 'utf8'));
    const sites = scenario.sites;
    const port = (url) => Number(new URL(url).port);
    writeAtomically(path.join(DATA, 'sites.json'), JSON.stringify({
        contentProfile: 'profile-tennis',
        sites: [
            { id: 'ts-live', plugin: 'plugin-ts-live', account: sites['ts-live'].accounts[0].username, config: { baseUrl: urls['ts-live'] } },
            { id: 'ladder-live', plugin: 'plugin-ladder-live', config: { baseUrl: urls['ladder-live'] } },
            { id: 'fmp4-live', plugin: 'plugin-fmp4-live', config: { baseUrl: urls['fmp4-live'], playlistKeys: sites['fmp4-live'].obfuscation.keys } },
        ],
        fileHosts: [{ id: 'file-host', plugin: 'plugin-file-host', allowPorts: [port(urls['file-host']), port(urls['file-host-cdn'])],
            config: { origin: urls['file-host'], downloadHosts: ['127.0.0.1'], directory: '~/Videos/file-host' } }],
        destinations: [DESTINATION === 'api-host'
            ? { id: 'api-host', plugin: 'plugin-api-host', config: { baseUrl: urls['api-host'], clientId: 'sim-client', clientSecret: 'sim-secret' } }
            : { id: 'form-host', plugin: 'plugin-form-host', config: { baseUrl: urls['form-host'] } }],
    }, null, 2) + '\n');
    const ts = sites['ts-live'].accounts[0];
    writeAtomically(path.join(HOME, '.config', 'video-services', 'auth-accounts.json'),
        JSON.stringify({ accounts: [{ email: ts.username, password: ts.password, provider: 'ts-live' }] }) + '\n', 0o600);
    const uploader = sites[DESTINATION].accounts[0];
    writeAtomically(path.join(DATA, 'upload-providers.json'),
        JSON.stringify({ version: 1, providers: { [DESTINATION]: { username: uploader.username, password: uploader.password } } }) + '\n', 0o600);
    const lists = {
        'ts-live': (channel) => `${channel.id} ${channel.name}`,
        'ladder-live': (channel) => `${channel.id} ${channel.name}`,
        'fmp4-live': (channel) => `${channel.name} ${channel.id}`,
    };
    for (const [site, line] of Object.entries(lists)) {
        const file = path.join(DATA, 'download-lists', `${site}.txt`);
        if (!existsSync(file)) writeAtomically(file, sites[site].channels.map(line).join('\n') + '\n');
    }
}

// The campaign's first configuration: every recording, uploaded to the demo's destination.
function configureCampaign(env) {
    const marker = path.join(DEMO, `campaign-configured-${DESTINATION}`);
    if (existsSync(marker)) return;
    for (const args of [['campaign-configure', '--provider', 'all', '--apply'], ['upload-provider', '--provider', DESTINATION, '--apply'], ['campaign-resume', '--apply']]) {
        const result = spawnSync(process.execPath, ['--no-warnings', 'dist/main.js', ...args], { cwd: path.join(ROOT, 'packages', 'pipeline'), env: { ...baseEnv(), ...env }, encoding: 'utf8' });
        if (result.status !== 0) throw new Error(`pipeline ${args.join(' ')}: ${result.stderr.trim().split('\n').slice(-3).join(' | ')}`);
    }
    writeAtomically(marker, `${new Date().toISOString()}\n`);
}

// ---- the run -------------------------------------------------------------------------------

mkdirSync(DEMO, { recursive: true });
const media = await prepareMedia();
const { cert, key } = certificate();
const modelUrl = process.env.DEMO_MODEL_URL ?? await modelStandIn();

const simulator = start('simulator', process.execPath, [path.join(ROOT, 'packages', 'simulator', 'dist', 'cli.js'), 'serve',
    '--scenario', SCENARIO, '--media', media, '--state', path.join(DEMO, 'simulator'), '--host', '0.0.0.0', '--clock', 'real',
    '--tls-cert', cert, '--tls-key', key, '--truth-max-bytes', '200M', '--truth-keep', '3']);
const listening = await waitForLine(simulator, /^\{"event":"listening".*\}$/, 120_000);
const urls = JSON.parse(listening[0]);
say(`simulator up: ${Object.entries(urls).filter(([, value]) => typeof value === 'string' && value.startsWith('http')).map(([name, value]) => `${name} ${value}`).join(', ')}`);
configure(urls);

const auth = start('auth', process.execPath, [path.join(ROOT, 'packages', 'auth', 'dist', 'main.js')]);
await waitForLine(auth, /Session successfully established/, 60_000).catch((error) => say(`${error.message}; starting the others anyway`));
start('downloader', process.execPath, [path.join(ROOT, 'packages', 'downloader', 'dist', 'main.js')]);
start('server', process.execPath, [path.join(ROOT, 'packages', 'server', 'dist', 'main.js')]);
// Exit 78: the sites file names no file host; nothing to serve.
start('file-hosts', process.execPath, [path.join(ROOT, 'packages', 'server', 'dist', 'fileHosts.js')], { final: [78] });
start('dashboard', 'python3', [path.join(ROOT, 'packages', 'pipeline', 'dashboard', 'server.py')],
    { env: { VIDEO_DASHBOARD_SERVICES_FILE: STATUS_FILE, VIDEO_DASHBOARD_EXTRA_UNITS: 'video-file-hosts=File-host queue' } });

const pipelineEnv = {
    VIDEO_PIPELINE_SERVICE_MODE: '1', VIDEO_PIPELINE_NETWORK_UPLOADS: '1', VIDEO_PIPELINE_CLEANUP: process.env.DEMO_CLEANUP === '1' ? '1' : '0',
    VIDEO_UPLOAD_PROVIDERS_FILE: path.join(DATA, 'upload-providers.json'), DESCRIPTOR_MODEL_URL: modelUrl,
};
configureCampaign(pipelineEnv);
start('pipeline', process.execPath, ['--no-warnings', 'dist/main.js', 'campaign-worker'], {
    cwd: path.join(ROOT, 'packages', 'pipeline'), env: pipelineEnv,
    // The worker's latest step, for the dashboard (systemd's journal holds it elsewhere).
    onLine: (line) => {
        if (!line.startsWith('{"event":"campaign-step"')) return;
        try {
            const step = JSON.parse(line).result?.step ?? {};
            workerStep = { disposition: step.disposition ?? null, reason: step.reason ?? null };
            writeStatus();
        } catch { /* not JSON after all */ }
    },
});
say('all services started: the website on https://<host>:29999, the dashboard on :28791, the file-host queue on :29998');
