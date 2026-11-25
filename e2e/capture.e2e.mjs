#!/usr/bin/env node
// End-to-end: the real downloader core records the simulated live sites through the
// public plug-ins, the real auth daemon keeps the account-gated site's session, and the
// simulator's checker judges every recording folder against the ground-truth log.
//
//   npm run build:downloader && npm run build -w auth && npm run build -w simulator && npm run build:sim-plugins
//   npm run e2e:capture            (under two minutes; E2E_KEEP=1 keeps everything)
//
// 1. Tiny generated media (a test pattern; ffmpeg under nice), prepared once per run.
// 2. The simulator in this process, real clock, ephemeral ports on 127.0.0.1, with a
//    scenario of ten channels on three sites (below): a healthy channel per open site
//    (one renamed, all fMP4 playlists obfuscated, with a key rotation), a playlist outage
//    shorter and one longer than the live window, a provider skip with a numbering
//    restart and a stream end, an edge outage that needs failover, fragments failing on
//    one edge, a damaged-segment window with a stream end, and on the account-gated
//    site a revocation of every stream token in flight and a stream end.
// 3. A sites file, an accounts file and download lists in a temporary data root; the
//    auth daemon (packages/auth/dist/main.js) signs the account in and renews its
//    stream tokens every five seconds, and the downloader (packages/downloader/dist/
//    main.js) records with them. Both are child processes whose every path (data root,
//    downloads root, sites file, accounts file, HOME) points into that root.
// 4. After the run, SIGTERM (graceful stop), then the checker on every folder, the
//    processes' own log lines, and the assertions. A JSON and a Markdown report go to
//    the run's directory and the Markdown is printed.
//
// Exit status: 0 when every assertion holds, 1 otherwise, 2 when the run could not
// happen (missing build, isolation guard).
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_S = Number(process.env.E2E_RUN_S ?? 90);
const STOP_GRACE_MS = 30_000;

const need = [
    'packages/downloader/dist/main.js',
    'packages/auth/dist/main.js',
    'packages/simulator/dist/index.js',
    'packages/sdk/dist/index.js',
    'plugins/ladder-live/dist/index.js',
    'plugins/fmp4-live/dist/index.js',
    'plugins/ts-live/dist/index.js',
];
for (const file of need) {
    if (!existsSync(path.join(ROOT, file))) {
        console.error(`missing ${file}: build first (npm run build:downloader && npm run build -w auth && npm run build -w simulator && npm run build:sim-plugins)`);
        process.exit(2);
    }
}
const { startSimulator, TruthIndex, MediaLibrary, checkRecording, formatReport, prepAll, normalizeRecordingId } = await import(path.join(ROOT, 'packages/simulator/dist/index.js'));
const { dropZeroSizeSamples } = await import(path.join(ROOT, 'packages/sdk/dist/index.js'));

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(0)}s`;
const say = (message) => console.log(`[e2e ${elapsed()}] ${message}`);

// ---- isolation -----------------------------------------------------------------------

const runDir = mkdtempSync(path.join(os.tmpdir(), 'capture-e2e-'));
const dirs = {
    home: path.join(runDir, 'home'),
    data: path.join(runDir, 'data'),
    downloads: path.join(runDir, 'downloads'),
    sim: path.join(runDir, 'sim-state'),
    media: path.join(runDir, 'media'),
};
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
const sitesFile = path.join(dirs.data, 'sites.json');

// Production paths this run must never touch (read-only checks only).
const realHome = os.homedir();
const production = [
    path.join(realHome, '.local', 'share', 'video-services'),
    path.join(realHome, 'Videos', 'downloads'),
];
const inside = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const childEnv = {
    PATH: process.env.PATH,
    LANG: 'C.UTF-8',
    ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
    // The downloader writes live-status.json under $HOME (not under the data root), and
    // folders without media go to the desktop trash: both stay in the run directory.
    HOME: dirs.home,
    XDG_DATA_HOME: path.join(dirs.home, '.local', 'share'),
    XDG_CONFIG_HOME: path.join(dirs.home, '.config'),
    XDG_CACHE_HOME: path.join(dirs.home, '.cache'),
    VIDEO_SERVICES_DATA_ROOT: dirs.data,
    VIDEO_DOWNLOADS_ROOT: dirs.downloads,
    VIDEO_SITES_FILE: sitesFile,
    LOG_LEVEL: 'debug',
};

function guardIsolation() {
    for (const dir of [...Object.values(dirs), sitesFile]) {
        if (!inside(runDir, dir) || production.some((p) => inside(p, dir) || inside(dir, p))) {
            throw new Error(`isolation guard: ${dir} is not a private run path`);
        }
    }
    // Ask the downloader's own path resolution (shared + node:os) in a child with the
    // exact environment the downloader gets.
    const probe = execFileSync(process.execPath, ['--input-type=module', '-e',
        "import { downloadsRoot, servicesDataRoot, downloadListPath, servicesHome, servicesStateHome, sitesFilePath, authAccountsPath } from 'shared'; import os from 'node:os';"
        + " console.log(JSON.stringify({ downloadsRoot, servicesDataRoot, list: downloadListPath('x'), home: os.homedir(),"
        + " sessions: servicesHome(), signInState: servicesStateHome(), sitesFile: sitesFilePath(), authAccounts: authAccountsPath() }))"],
    { cwd: ROOT, env: childEnv, encoding: 'utf8' });
    const seen = JSON.parse(probe);
    for (const [name, value] of Object.entries(seen)) {
        if (!inside(runDir, value) || production.some((p) => inside(p, value))) {
            throw new Error(`isolation guard: the downloader would use ${name}=${value}`);
        }
    }
    return seen;
}

// Production's own downloader rewrites its live-status.json whenever its recordings
// change, so the file's mtime proves nothing. Instead: the run's status file must be
// written inside the run directory, and production's must never name a test channel.
const statusFile = path.join(realHome, '.local', 'share', 'video-services', 'live-status.json');
const runStatusFile = () => path.join(dirs.home, '.local', 'share', 'video-services', 'live-status.json');
function isolationHeld() {
    const names = CHANNELS.flatMap((c) => [c.name, ...(c.renames ?? []).map((r) => r.name)]);
    const production = existsSync(statusFile) ? readFileSync(statusFile, 'utf8') : '';
    const leaked = names.filter((name) => production.includes(`"${name}"`));
    return { held: leaked.length === 0 && existsSync(runStatusFile()), leaked, runStatusWritten: existsSync(runStatusFile()) };
}

// ---- media and scenario --------------------------------------------------------------

async function prepareMedia() {
    const input = path.join(dirs.media, 'in');
    mkdirSync(input, { recursive: true });
    for (const [name, frequency] of [['Practice A.mkv', 440], ['Practice B.mkv', 660]]) {
        execFileSync('nice', ['-n', '19', 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
            '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000`,
            '-t', '10', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-threads', '2',
            '-c:a', 'aac', '-b:a', '48k', path.join(input, name)]);
    }
    const cache = path.join(dirs.media, 'cache');
    await prepAll({ input, out: cache });
    return cache;
}

const KEYS = { k1: 'e2e-secret-one', k2: 'e2e-secret-two' };

// Each channel starts a second after the previous one, so recording identities (whole
// seconds on both sites) are distinct and log lines can be told apart.
const CHANNELS = [
    { site: 'ladder-live', id: '101', name: 'centre-court', start: 0, kind: 'healthy', faults: [] },
    { site: 'ladder-live', id: '102', name: 'court-two', start: 1, kind: 'short-outage',
      faults: [{ type: 'playlistStatus', at: 30, until: 34, status: 503 }] },
    { site: 'ladder-live', id: '103', name: 'court-three', start: 2, kind: 'long-outage',
      faults: [{ type: 'playlistStatus', at: 30, until: 52, status: 503 }] },
    { site: 'ladder-live', id: '104', name: 'court-four', start: 3, kind: 'skip-restart-end', end: 70,
      faults: [{ type: 'skip', at: 25, count: 3 }, { type: 'restart', at: 45, value: 1 }] },
    { site: 'fmp4-live', id: '201', name: 'rally-one', start: 4, kind: 'healthy', obfuscated: true,
      renames: [{ at: 40, name: 'rally-one-tv' }], faults: [] },
    // The outage starts a second into a fragment, so the next request to edge a is a
    // playlist poll: the core's own failover (recoverVariant, EDGE-SWITCH) takes over.
    // Edge b stamps its date-times 20 ms after edge a (edges skew by tens of ms): the
    // segment last saved from a comes back 20 ms "later" (B1 in the notes).
    { site: 'fmp4-live', id: '202', name: 'rally-two', start: 5, kind: 'edge-failover', obfuscated: true,
      edges: [{ id: 'a' }, { id: 'b', lagMs: 300, pdtSkewMs: 20 }, { id: 'c', lagMs: 600, pdtSkewMs: -15 }],
      faults: [{ type: 'edgeOutage', edge: 'a', at: 30, until: 60, status: 503 }] },
    { site: 'fmp4-live', id: '203', name: 'rally-three', start: 6, kind: 'damage-end', obfuscated: true, end: 75,
      faults: [{ type: 'damage', at: 20, until: 32, kind: 'zero-size-sample' }] },
    // Fragments fail on edge a while its playlist answers: the attempt stops, and the
    // session starts again from the edge the plug-in names (shouldRetry). A window of
    // six fragments still lists what was saved before the pause (B2 in the notes); edge
    // b stamps 20 ms early, so only the stitching across attempts is under test.
    { site: 'fmp4-live', id: '204', name: 'rally-four', start: 7, kind: 'segment-failover', obfuscated: true, window: 6,
      edges: [{ id: 'a' }, { id: 'b', lagMs: 300, pdtSkewMs: -20 }, { id: 'c', lagMs: 600, pdtSkewMs: -15 }],
      faults: [{ type: 'segmentStatus', edge: 'a', at: 30, until: 40, status: 503 }] },
    // The account-gated site: at 40 s the site revokes every stream token it has issued
    // (TS_REVOKE_S, a site fault), so both channels' playlists answer 401 until the auth
    // daemon's next renewal (every five seconds) reaches the credential store.
    { site: 'ts-live', id: 'acct-show', name: 'show-court', start: 8, kind: 'token-revoke', faults: [] },
    { site: 'ts-live', id: 'acct-no1', name: 'no1-court', start: 9, kind: 'token-revoke-end', end: 70, faults: [] },
];

const TS_ACCOUNT = { username: 'viewer', password: 'e2e-password', accountId: 'acct-viewer' };
const TS_REVOKE_S = 40;

function scenario(epoch) {
    const channel = (c) => ({
        id: c.id, name: c.name,
        schedule: { sessions: [{ start: c.start, end: c.end ?? null }] },
        ...(c.edges ? { edges: c.edges } : {}),
        ...(c.window ? { window: c.window } : {}),
        ...(c.renames ? { renames: c.renames } : {}),
        ...(c.obfuscated ? { obfuscated: true } : {}),
        faults: c.faults,
    });
    return {
        name: 'capture e2e',
        seed: 'capture-e2e-1',
        epoch,
        segmentRetentionS: 120,
        sites: {
            'ladder-live': { channels: CHANNELS.filter((c) => c.site === 'ladder-live').map(channel) },
            'fmp4-live': {
                edges: ['a', 'b', 'c'],
                obfuscation: { keys: KEYS, keyId: 'k1' },
                faults: [{ type: 'obfuscationKey', at: 50, keyId: 'k2' }],
                channels: CHANNELS.filter((c) => c.site === 'fmp4-live').map(channel),
            },
            'ts-live': {
                accounts: [TS_ACCOUNT],
                faults: [{ type: 'tokenRevoke', at: TS_REVOKE_S }],
                channels: CHANNELS.filter((c) => c.site === 'ts-live').map(channel),
            },
        },
    };
}

// ---- the run -------------------------------------------------------------------------

let sim = null;
let child = null;
let authChild = null;
const logLines = [];
const authLines = [];

// A service as a child process with the run's environment; its output goes to a log file
// and, without colour codes, to lines.
function startService(script, logFile, lines) {
    const logStream = createWriteStream(logFile);
    const proc = spawn(process.execPath, [path.join(ROOT, script)], { cwd: runDir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })));
    let partial = '';
    const onData = (chunk) => {
        logStream.write(chunk);
        partial += chunk.toString();
        const complete = partial.split('\n');
        partial = complete.pop();
        for (const line of complete) lines.push(line.replace(/\x1b\[[0-9;]*m/g, ''));
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    const close = async () => {
        if (partial) lines.push(partial);
        partial = '';
        await new Promise((resolve) => logStream.end(resolve));
    };
    return { proc, exited, close };
}

// Stops a service with SIGTERM, then SIGKILL after the grace period.
async function stopService(service, name) {
    service.proc.kill('SIGTERM');
    const stop = await Promise.race([service.exited, new Promise((resolve) => setTimeout(() => resolve(null), STOP_GRACE_MS))]);
    await service.close();
    if (!stop) {
        service.proc.kill('SIGKILL');
        throw new Error(`the ${name} did not stop within 30 s of SIGTERM`);
    }
    return stop;
}

async function run() {
    const seen = guardIsolation();
    say(`run directory ${runDir}`);
    say(`downloader paths: ${JSON.stringify(seen)}`);

    const cache = await prepareMedia();
    say('media prepared');

    const epoch = Math.ceil((Date.now() + 1500) / 1000) * 1000;
    sim = await startSimulator({
        scenario: scenario(epoch), media: cache, stateDir: dirs.sim, host: '127.0.0.1', ports: {}, clockMode: 'real',
    });
    say(`simulator up: ladder-live ${sim.urls['ladder-live']}, fmp4-live ${sim.urls['fmp4-live']}, ts-live ${sim.urls['ts-live']}`);

    writeFileSync(sitesFile, JSON.stringify({ sites: [
        { id: 'ladder-live', plugin: 'plugin-ladder-live', config: { baseUrl: sim.urls['ladder-live'], pollIntervalMs: 2000, playlistRetryMs: 1000 } },
        { id: 'fmp4-live', plugin: 'plugin-fmp4-live', config: { baseUrl: sim.urls['fmp4-live'], playlistKeys: KEYS, pollIntervalMs: 2000, playlistRetryMs: 1000 } },
        { id: 'ts-live', plugin: 'plugin-ts-live', account: TS_ACCOUNT.username, config: { baseUrl: sim.urls['ts-live'], pollIntervalMs: 2000, playlistRetryMs: 1000 } },
    ] }, null, 2));
    mkdirSync(path.dirname(seen.authAccounts), { recursive: true });
    writeFileSync(seen.authAccounts, JSON.stringify({ accounts: [{ email: TS_ACCOUNT.username, password: TS_ACCOUNT.password, provider: 'ts-live' }] }), { mode: 0o600 });
    mkdirSync(path.join(dirs.data, 'download-lists'), { recursive: true });
    writeFileSync(path.join(dirs.data, 'download-lists', 'ladder-live.txt'),
        CHANNELS.filter((c) => c.site === 'ladder-live').map((c) => `${c.id} ${c.name}`).join('\n') + '\n');
    writeFileSync(path.join(dirs.data, 'download-lists', 'fmp4-live.txt'),
        CHANNELS.filter((c) => c.site === 'fmp4-live').map((c) => `${c.name} ${c.id}`).join('\n') + '\n');
    writeFileSync(path.join(dirs.data, 'download-lists', 'ts-live.txt'),
        CHANNELS.filter((c) => c.site === 'ts-live').map((c) => `${c.id} ${c.name}`).join('\n') + '\n');

    // The auth daemon first: the downloader reads the session it saves.
    const authLogFile = path.join(runDir, 'auth.log');
    const auth = startService('packages/auth/dist/main.js', authLogFile, authLines);
    authChild = auth.proc;
    const signedIn = Date.now() + 20_000;
    while (!authLines.some((line) => /Token write — source=\S+ stream_expires=\d+/.test(line)) && Date.now() < signedIn && authChild.exitCode === null) {
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!authLines.some((line) => /Token write — source=\S+ stream_expires=\d+/.test(line))) {
        throw new Error(`the auth daemon saved no stream tokens within 20 s; see ${authLogFile}`);
    }
    say(`auth daemon signed in (pid ${authChild.pid})`);

    const logFile = path.join(runDir, 'downloader.log');
    const downloader = startService('packages/downloader/dist/main.js', logFile, logLines);
    child = downloader.proc;
    const exited = downloader.exited;
    say(`downloader started (pid ${child.pid}), recording until epoch + ${RUN_S}s`);

    const stopAt = epoch + RUN_S * 1000;
    let early = null;
    exited.then((result) => { early = result; });
    while (Date.now() < stopAt && !early) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(15_000, Math.max(0, stopAt - Date.now()))));
        if (!early && Date.now() < stopAt) say(`recording... ${((Date.now() - epoch) / 1000).toFixed(0)}s into the scenario, ${logLines.length} log lines`);
    }
    if (early) throw new Error(`the downloader exited early (${JSON.stringify(early)}); see ${logFile}`);
    if (authChild.exitCode !== null) throw new Error(`the auth daemon exited early (${authChild.exitCode}); see ${authLogFile}`);

    const stop = await stopService(downloader, 'downloader');
    say(`downloader stopped (${JSON.stringify(stop)})`);
    const authStop = await stopService(auth, 'auth daemon');
    say(`auth daemon stopped (${JSON.stringify(authStop)})`);
    await sim.close();
    sim = null;

    const isolation = isolationHeld();
    return { epoch, cache, stop, authStop, logFile, authLogFile, isolation };
}

// ---- judging -------------------------------------------------------------------------

function recordingFolders() {
    const folders = [];
    for (const site of ['ladder-live', 'fmp4-live', 'ts-live']) {
        for (const state of ['.active', '.pending']) {
            const dir = path.join(dirs.downloads, site, 'downloaded', state);
            if (!existsSync(dir)) continue;
            for (const name of readdirSync(dir).sort()) {
                const alias = /^\d{4}-\d{2}-\d{2} \d{6} (.+)$/.exec(name)?.[1];
                folders.push({ site, state: state.slice(1), name, alias, dir: path.join(dir, name) });
            }
        }
    }
    return folders;
}

const GAP = /\[PlaylistManager\] SEQUENCE-GAP recording=(\S+) missing=(-?\d+)-(-?\d+) \((\d+) segments\).*: (this loop polled too late|the provider skipped them)/;
const RESTART = /\[PlaylistManager\] SEQUENCE-RESTART recording=(\S+)/;
const REPAIR = /\[StreamDownloader\] (\S+) repaired segment (\S+): (.*)$/;
const EDGE_SWITCH = /\[StreamDownloader\] (\S+) EDGE-SWITCH (\S+) → (\S+)/;
const ENDED = /\[StreamSession\] (\S+): recording ended \(([^)]*)\)/;
const LEVEL = /\[downloader\] (\w+):/;
const RENAMED = /\[Australian Open\] Channel (\d+) is now named (\S+) \(was (\S+)\)/;
const UNAUTHORIZED = /\[Wimbledon\] Playlist 401 \(stream token (\w+)\) url=\S+\/hls\/(\d+)\//;
const AUTHORIZED = /\[Wimbledon\] Playlist authorized again after (\d+) 401 answer\(s\) url=\S+\/hls\/(\d+)\//;
const UNDECODABLE = /Cannot decode playlists with key/;

function logFacts(lines) {
    const facts = { gaps: [], restarts: [], repairs: [], edgeSwitches: [], ended: [], renames: [], unauthorized: [], authorized: [], undecodable: 0, errors: [], warnings: 0 };
    for (const line of lines) {
        const level = LEVEL.exec(line)?.[1] ?? 'unknown';
        if (level === 'warn') facts.warnings++;
        if (level === 'error') facts.errors.push(line);
        let m;
        if ((m = GAP.exec(line))) facts.gaps.push({ level, recording: m[1], from: Number(m[2]), to: Number(m[3]), count: Number(m[4]), cause: m[5] === 'the provider skipped them' ? 'site' : 'client' });
        else if ((m = RESTART.exec(line))) facts.restarts.push({ recording: m[1] });
        else if ((m = REPAIR.exec(line))) facts.repairs.push({ alias: m[1], file: m[2], detail: m[3] });
        else if ((m = EDGE_SWITCH.exec(line))) facts.edgeSwitches.push({ alias: m[1], from: m[2], to: m[3] });
        else if ((m = ENDED.exec(line))) facts.ended.push({ alias: m[1], reason: m[2] });
        else if ((m = RENAMED.exec(line))) facts.renames.push({ id: m[1], name: m[2], was: m[3] });
        else if ((m = UNAUTHORIZED.exec(line))) facts.unauthorized.push({ reason: m[1], recording: m[2] });
        else if ((m = AUTHORIZED.exec(line))) facts.authorized.push({ answers: Number(m[1]), recording: m[2] });
        if (UNDECODABLE.test(line)) facts.undecodable++;
    }
    return facts;
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function judge({ cache, stop, authStop, logFile, authLogFile, isolation }) {
    const truth = TruthIndex.fromFile(dirs.sim);
    const media = MediaLibrary.load(cache);
    const facts = logFacts(logLines);
    const folders = recordingFolders();
    const results = [];
    const failures = [];
    const expect = (ok, channel, message) => {
        if (!ok) failures.push({ channel, message });
        return ok;
    };

    expect(stop.code === 0, 'downloader', `exit code ${stop.code} (signal ${stop.signal}) after SIGTERM`);
    expect(logLines.some((line) => line.includes('Graceful shutdown complete.')), 'downloader', 'no "Graceful shutdown complete." line');
    expect(isolation.held, 'isolation', isolation.runStatusWritten
        ? `the production live-status.json names test channel(s): ${isolation.leaked.join(', ')}`
        : 'the run wrote no live-status.json in its own home (redirect not proven)');
    expect(facts.errors.length === 0, 'downloader', `${facts.errors.length} error line(s): ${facts.errors.slice(0, 3).join(' | ')}`);
    expect(facts.undecodable === 0, 'fmp4-live', 'a playlist could not be decoded (key rotation)');
    // The auth daemon: signed in once, logged no unexpected error, and renewed the stream
    // tokens (ten seconds) every five seconds all along, by the site's own record of what
    // it issued. A fresh e2e home has no saved session, so the single startup browser sign-in
    // logs "[bug event] ... no saved session" by design; any other error fails the run.
    const initialSignIn = /\[bug event\] Wimbledon browser sign-in for viewer: no saved session/;
    const initialSignInErrors = authLines.filter((line) => / error: /.test(line) && initialSignIn.test(line));
    const authErrors = authLines.filter((line) => / error: /.test(line) && !initialSignIn.test(line));
    const issued = truth.responses({ site: 'ts-live', kind: 'auth', status: 200 })
        .filter((r) => r.path.startsWith('/api/stream/token')).map((r) => r.t).sort((x, y) => x - y);
    const longestWait = Math.max(0, ...issued.slice(1).map((t, i) => t - issued[i]));
    expect(authStop.code === 0 || authStop.signal === 'SIGTERM', 'auth', `exit ${JSON.stringify(authStop)} after SIGTERM`);
    expect(authLines.filter((line) => /Session successfully established for viewer/.test(line)).length === 1, 'auth', 'not exactly one sign-in');
    expect(initialSignInErrors.length <= 1, 'auth', `${initialSignInErrors.length} initial no-saved-session error line(s)`);
    expect(authErrors.length === 0, 'auth', `${authErrors.length} error line(s): ${authErrors.slice(0, 3).join(' | ')}`);
    expect(issued.length >= Math.floor(RUN_S / 5) - 2 && longestWait <= 7_000, 'auth',
        `${issued.length} stream-token renewals in ${RUN_S} s, the longest ${longestWait} ms apart`);

    for (const channel of CHANNELS) {
        const key = `${channel.site}/${channel.id}`;
        const sessions = truth.sessions({ site: channel.site, channel: channel.id });
        const identities = new Set(sessions.map((s) => normalizeRecordingId(s.recordingId)));
        const own = folders.filter((f) => f.site === channel.site && (f.alias === channel.name || (channel.renames ?? []).some((r) => r.name === f.alias)));
        const gaps = facts.gaps.filter((g) => identities.has(g.recording));
        const restarts = facts.restarts.filter((r) => identities.has(r.recording));
        const aliases = new Set([channel.name, ...(channel.renames ?? []).map((r) => r.name)]);
        const repairs = facts.repairs.filter((r) => aliases.has(r.alias));
        const switches = facts.edgeSwitches.filter((s) => aliases.has(s.alias));
        const ended = facts.ended.filter((e) => aliases.has(e.alias));
        const unauthorized = facts.unauthorized.filter((u) => identities.has(u.recording));
        const authorized = facts.authorized.filter((a) => identities.has(a.recording));

        const result = { channel: key, name: channel.name, kind: channel.kind, folders: own.map((f) => `${f.state}/${f.name}`), expected: '', checker: null, logs: null, notes: [] };
        results.push(result);
        if (!expect(own.length === 1, key, `expected one recording folder, found ${own.length} (${own.map((f) => f.name).join(', ')})`)) continue;
        const folder = own[0];
        const report = checkRecording(truth, folder.dir, { site: channel.site, channel: channel.id, media });
        writeFileSync(path.join(runDir, `check-${channel.site}-${channel.id}.json`), JSON.stringify(report, null, 2));
        writeFileSync(path.join(runDir, `check-${channel.site}-${channel.id}.txt`), formatReport(report) + '\n');
        const c = report.counts;
        const edges = [...new Set(report.files.map((f) => f.edge).filter(Boolean))];
        result.checker = {
            files: c.files, exact: c.exact, missedByClient: c.missedByClient, skippedBySite: c.skippedBySite,
            duplicates: c.duplicates, byteMismatches: c.byteMismatches, unknownFiles: c.unknownFiles, unverified: c.unverified,
            edges, ended: report.recording.playlist.ended, missingFiles: report.recording.playlist.missingFiles.length,
            initFiles: report.recording.initFiles.length, unknownInits: report.recording.initFiles.filter((i) => i.known === false).length,
        };
        const clientGaps = gaps.filter((g) => g.cause === 'client');
        const siteGaps = gaps.filter((g) => g.cause === 'site');
        result.logs = {
            gapWarnings: clientGaps.length, gapWarnedSegments: clientGaps.reduce((n, g) => n + g.count, 0),
            siteSkipLines: siteGaps.length, siteSkippedSegments: siteGaps.reduce((n, g) => n + g.count, 0),
            restarts: restarts.length, repairs: repairs.length, edgeSwitches: switches.map((s) => `${s.from}→${s.to}`), ended: ended.map((e) => e.reason),
            ...(channel.site === 'ts-live' ? { unauthorized: unauthorized.map((u) => u.reason), authorizedAgainAfter: authorized.map((a) => a.answers) } : {}),
        };

        // Every channel: nothing the site never published, no duplicate, nothing missing
        // from the playlist, every init known, every byte as served except declared repairs.
        expect(c.files > 10, key, `only ${c.files} segment files`);
        expect(c.unknownFiles === 0, key, `${c.unknownFiles} unknown file(s)`);
        expect(c.duplicates === 0, key, `${c.duplicates} duplicate(s): ${report.duplicates.slice(0, 3).map((d) => `k ${d.k}: ${d.files.join(' + ')}`).join('; ')}`);
        expect(c.unverified === 0, key, `${c.unverified} unverified file(s)`);
        expect(result.checker.missingFiles === 0, key, 'the playlist names missing files');
        expect(result.checker.unknownInits === 0, key, 'an init file with unknown bytes');
        // Client misses are exactly the SEQUENCE-GAP warnings (outages longer than the
        // window); site skips are exactly the "provider skipped them" lines.
        const warnedSeqs = new Set(clientGaps.flatMap((g) => Array.from({ length: g.count }, (_, i) => g.from + i)));
        const missedSeqs = new Set(report.missedByClient.flatMap((m) => m.edges.map((e) => e.seq)));
        expect(c.missedByClient === warnedSeqs.size && [...warnedSeqs].every((s) => missedSeqs.has(s)), key,
            `client misses ${c.missedByClient} (seq ${[...missedSeqs].join(',')}) vs SEQUENCE-GAP warnings for ${warnedSeqs.size} (seq ${[...warnedSeqs].join(',')})`);
        expect(c.skippedBySite === result.logs.siteSkippedSegments, key,
            `skipped by the site ${c.skippedBySite} vs "provider skipped them" lines for ${result.logs.siteSkippedSegments}`);

        const repairedFiles = new Set(repairs.map((r) => r.file));
        for (const mismatch of report.byteMismatches) {
            const declared = repairedFiles.has(mismatch.file) && mismatch.expected.some((e) => e.damage === 'zero-size-sample');
            if (!expect(declared, key, `byte mismatch without a declared repair: ${mismatch.file}`)) continue;
            // The repair is exactly the SDK's: the served bytes with the zero-size sample
            // entries dropped.
            const position = truth.available({ site: channel.site, channel: channel.id }).find((a) => a.k === mismatch.k && a.edge === mismatch.edge && a.sha256 === mismatch.expected[0].sha256);
            const source = sessions.find((s) => s.session === position?.session)?.source;
            const served = position && source ? media.segmentBytes({ source, rendition: position.rendition, index: position.srcIndex, loop: position.loop, damage: position.damage }) : null;
            const repaired = served ? dropZeroSizeSamples(served) : null;
            expect(repaired !== null && sha256(repaired.data) === mismatch.sha256, key, `repaired bytes of ${mismatch.file} are not the served bytes minus the zero-size entries`);
        }
        expect(c.byteMismatches === repairs.length, key, `${c.byteMismatches} byte mismatch(es) vs ${repairs.length} repair line(s)`);

        for (const rename of channel.renames ?? []) {
            // The new name is logged once and kept in the plug-in's durable store.
            const stored = JSON.parse(readFileSync(path.join(dirs.data, 'site-state', channel.site, 'names.json'), 'utf8'))[channel.id] ?? [];
            expect(facts.renames.some((r) => r.id === channel.id && r.name === rename.name && r.was === channel.name), key, `no rename line for ${rename.name}`);
            expect(stored[0] === rename.name && stored.includes(channel.name), key, `the name history is ${JSON.stringify(stored)}`);
            result.notes.push(`renamed to ${rename.name}, history ${JSON.stringify(stored)}`);
        }

        switch (channel.kind) {
        case 'healthy':
            result.expected = channel.renames ? 'no miss, no skip (renamed mid-run; key rotated)' : 'no miss, no skip';
            expect(c.missedByClient === 0 && c.skippedBySite === 0 && gaps.length === 0, key, 'a healthy channel has a gap');
            expect(c.exact === c.files, key, 'not every file is byte-exact');
            break;
        case 'short-outage':
            result.expected = 'outage 4 s < window 8 s: no miss';
            expect(c.missedByClient === 0 && clientGaps.length === 0, key, 'a short outage cost segments');
            expect(c.exact === c.files, key, 'not every file is byte-exact');
            break;
        case 'long-outage':
            result.expected = 'outage 22 s > window 8 s: client misses = SEQUENCE-GAP warnings';
            expect(c.missedByClient > 0 && clientGaps.length > 0, key, 'a long outage cost no segment');
            break;
        case 'skip-restart-end':
            result.expected = 'skip 3 (site), numbering restart, stream end (master 403): ended at once';
            expect(c.skippedBySite === 3, key, `skipped by the site ${c.skippedBySite}, expected 3`);
            expect(c.missedByClient === 0, key, 'segments missed around the skip or the restart');
            expect(restarts.length >= 1, key, 'no SEQUENCE-RESTART line');
            expect(folder.state === 'pending' && report.recording.playlist.ended, key, `the ended stream is not finalized (${folder.state}, ENDLIST=${report.recording.playlist.ended})`);
            expect(ended.some((e) => e.reason === 'the live playlist is gone'), key, `ended for: ${ended.map((e) => e.reason).join(', ') || 'nothing'}`);
            break;
        case 'edge-failover':
            result.expected = 'edge a down 30 s: failover, no duplicate, no miss';
            expect(edges.length >= 2 && switches.length > 0, key, `recorded from ${edges.join(', ')} with ${switches.length} EDGE-SWITCH line(s)`);
            expect(c.missedByClient === 0, key, `${c.missedByClient} segment(s) missed across the failover`);
            break;
        case 'segment-failover':
            result.expected = 'fragments fail on edge a: session restarts on edge b, no duplicate, no miss';
            expect(edges.length >= 2 && switches.some((s) => s.from === 'a'), key, `recorded from ${edges.join(', ')} with ${switches.length} EDGE-SWITCH line(s)`);
            expect(c.missedByClient === 0, key, `${c.missedByClient} segment(s) missed across the restart`);
            break;
        case 'token-revoke':
        case 'token-revoke-end':
            result.expected = `stream tokens revoked at ${TS_REVOKE_S} s: 401s until the auth daemon's renewal, then recorded on`
                + (channel.kind === 'token-revoke-end' ? '; stream end finalizes it' : '');
            expect(unauthorized.some((u) => u.reason === 'revoked'), key, `no "Playlist 401 (stream token revoked)" line (${unauthorized.map((u) => u.reason).join(', ') || 'none'})`);
            expect(authorized.length >= 1 && authorized.every((a) => a.answers <= 10), key, `authorized again after ${authorized.map((a) => a.answers).join(', ') || 'never'} 401 answer(s)`);
            expect(c.skippedBySite === 0, key, `${c.skippedBySite} segment(s) skipped by the site`);
            if (channel.kind === 'token-revoke-end') {
                expect(folder.state === 'pending' && report.recording.playlist.ended, key, `the ended stream is not finalized (${folder.state}, ENDLIST=${report.recording.playlist.ended})`);
                expect(ended.length >= 1, key, 'no "recording ended" line');
            }
            break;
        case 'damage-end':
            result.expected = 'zero-size samples repaired; ENDLIST ends it';
            expect(repairs.length > 0 && c.byteMismatches === repairs.length, key, `${repairs.length} repairs, ${c.byteMismatches} mismatches`);
            expect(c.missedByClient === 0 && c.skippedBySite === 0, key, 'segments missed around the damage');
            expect(folder.state === 'pending' && report.recording.playlist.ended, key, `the ended stream is not finalized (${folder.state})`);
            expect(ended.some((e) => e.reason === 'the provider ended the playlist'), key, `ended for: ${ended.map((e) => e.reason).join(', ') || 'nothing'}`);
            break;
        }
    }
    return { results, failures, facts, logFile };
}

function markdown(summary) {
    const rows = summary.results.map((r) => {
        const c = r.checker ?? {};
        const l = r.logs ?? {};
        return `| ${r.channel} ${r.name} | ${r.expected} | ${c.files ?? '-'} files, ${c.exact ?? '-'} exact; missed ${c.missedByClient ?? '-'}, site-skipped ${c.skippedBySite ?? '-'}, dup ${c.duplicates ?? '-'}, mismatch ${c.byteMismatches ?? '-'}; edges ${(c.edges ?? []).join('+') || '-'} | gap warn ${l.gapWarnings ?? '-'} (${l.gapWarnedSegments ?? '-'} seg), site skip ${l.siteSkipLines ?? '-'} (${l.siteSkippedSegments ?? '-'} seg), restart ${l.restarts ?? '-'}, repaired ${l.repairs ?? '-'}, switch ${(l.edgeSwitches ?? []).join(' ') || '-'}, ended ${(l.ended ?? []).join('; ') || '-'}${r.notes.length ? `; ${r.notes.join('; ')}` : ''} |`;
    });
    return [
        `# Capture e2e: ${summary.ok ? 'PASS' : 'FAIL'}`,
        '',
        `Run ${summary.runDir}, ${summary.durationS} s (recording ${RUN_S} s). Downloader exit: ${JSON.stringify(summary.stop)}; auth daemon exit: ${JSON.stringify(summary.authStop)}.`,
        '',
        '| Channel | Expected | Checker | Downloader log |',
        '|---|---|---|---|',
        ...rows,
        '',
        summary.failures.length
            ? `Failures:\n${summary.failures.map((f) => `- ${f.channel}: ${f.message}`).join('\n')}`
            : 'All assertions hold.',
        '',
    ].join('\n');
}

let exitCode = 2;
try {
    const outcome = await run();
    const judged = judge(outcome);
    const summary = {
        ok: judged.failures.length === 0,
        runDir,
        durationS: Math.round((Date.now() - started) / 1000),
        recordingS: RUN_S,
        stop: outcome.stop,
        authStop: outcome.authStop,
        failures: judged.failures,
        results: judged.results,
        log: { file: judged.logFile, lines: logLines.length, warnings: judged.facts.warnings, errors: judged.facts.errors.length },
        authLog: { file: outcome.authLogFile, lines: authLines.length },
    };
    writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(summary, null, 2) + '\n');
    const text = markdown(summary);
    writeFileSync(path.join(runDir, 'report.md'), text);
    console.log('\n' + text);
    exitCode = summary.ok ? 0 : 1;
    if (exitCode === 0 && process.env.E2E_KEEP !== '1') {
        // Keep the reports, the checker output and the log; drop media and recordings.
        for (const dir of [dirs.media, dirs.downloads, dirs.sim, dirs.home]) rmSync(dir, { recursive: true, force: true });
    }
    say(`reports in ${runDir}`);
} catch (error) {
    console.error(`[e2e] ${error?.stack ?? error}`);
    if (child && child.exitCode === null) child.kill('SIGKILL');
    if (authChild && authChild.exitCode === null) authChild.kill('SIGKILL');
    if (sim) await sim.close().catch(() => {});
}
process.exit(exitCode);
