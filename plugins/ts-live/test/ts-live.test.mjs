// ts-live against the simulator, in process: ephemeral ports on 127.0.0.1, a manual clock
// and tiny generated media (ffmpeg under nice). Every address comes from the config, as in
// the sites file; the credentials the auth side produces reach capture and catalog only
// through a credential source, as the core's store hands them over.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PlaylistNotFoundError, SDK_VERSION } from 'sdk';
import { MediaLibrary, SimClock, prepAll, startSimulator } from 'simulator';
import { ChallengeRequired, SessionRejected, SignInRefused, claimsOf, parseVariants, plugin, readConfig } from '../dist/index.js';

const EPOCH = Date.parse('2026-06-01T12:00:00.000Z');
const ACCOUNT = { email: 'viewer', password: 'secret' };

let media = null;
// One tiny source per test process.
function library() {
    media ??= (async () => {
        const root = mkdtempSync(path.join(os.tmpdir(), 'ts-live-plugin-'));
        process.on('exit', () => rmSync(root, { recursive: true, force: true }));
        mkdirSync(path.join(root, 'in'));
        execFileSync('nice', ['-n', '19', 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
            '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-threads', '2', '-c:a', 'aac', '-b:a', '48k',
            path.join(root, 'in', 'Practice.mkv')]);
        await prepAll({ input: path.join(root, 'in'), out: path.join(root, 'cache') });
        return MediaLibrary.load(path.join(root, 'cache'));
    })();
    return media;
}

function scenario(extra = {}) {
    return {
        name: 'ts-live plug-in', seed: 'ts-live-plugin', epoch: EPOCH,
        sites: { 'ts-live': {
            accounts: [{ username: 'viewer', password: 'secret', accountId: 'acct-viewer', follows: ['acct-centre'] }],
            channels: [
                { id: 'acct-centre', name: 'centre-court', schedule: { sessions: [{ start: 0, end: 120 }, { start: 300 }] }, endlistS: 6,
                  renames: [{ at: 100, name: 'show-court' }] },
                { id: 'acct-outer', name: 'outer-court', schedule: { sessions: [{ start: 0 }] } },
                { id: 'acct-later', name: 'court-three', schedule: { sessions: [{ start: 1000 }] } },
            ],
            ...extra,
        } },
    };
}

function recordingLogger() {
    const lines = [];
    const at = (level) => (message, meta) => lines.push({ level, message, meta });
    return { lines, log: { debug: at('debug'), verbose: at('verbose'), info: at('info'), warn: at('warn'), error: at('error') } };
}

// An in-memory alias registry, as the server's behaves.
function aliasBook() {
    const names = new Map();
    return {
        current: (id) => names.get(id)?.at(-1),
        idForName: (name) => [...names].find(([, list]) => list.includes(name))?.[0],
        names: (id) => names.get(id),
        record: async (id, { current, history }) => { names.set(id, [...history, current]); return true; },
    };
}

async function start(t, { at = EPOCH + 30_000, extra } = {}) {
    const clock = new SimClock({ mode: 'manual', at });
    const sim = await startSimulator({ scenario: scenario(extra), media: await library(), clock, autoPublish: false, memoryTruth: true, host: '127.0.0.1' });
    t.after(() => sim.close());
    // The credential store: what the auth side last saved.
    let saved = null;
    const store = { save: (record) => { saved = record; }, clear: () => { saved = null; }, saved: () => saved };
    const site = (config = {}) => {
        const { lines, log } = recordingLogger();
        const stateDir = mkdtempSync(path.join(os.tmpdir(), 'ts-live-state-'));
        t.after(() => rmSync(stateDir, { recursive: true, force: true }));
        const aliases = aliasBook();
        const instance = plugin.create({
            siteId: 'ts-live', config: { baseUrl: sim.urls['ts-live'], pollIntervalMs: 2000, ...config },
            store: { read: async () => undefined, write: async () => {}, update: async (_k, f) => f(undefined), delete: async () => {} },
            paths: { stateDir, downloadList: path.join(stateDir, 'list.txt'), browserProfiles: path.join(stateDir, 'profiles'), loginState: path.join(stateDir, 'login') },
            log, clock: { now: () => clock.now() }, aliases,
            credentials: { read: async () => ({ record: saved, writtenAtMs: saved ? clock.now() : null, readAtMs: clock.now() }) },
            browser: { executablePath: '/usr/bin/chromium' },
        });
        return { ...instance, lines, aliases };
    };
    return { sim, clock, base: sim.urls['ts-live'], site, store };
}

// Signs in through the plug-in's auth and saves the session with fresh stream tokens.
async function signedIn(s) {
    const instance = s.site();
    const bag = await instance.auth.login(ACCOUNT);
    const short = await instance.auth.fetchShortTokens(bag, 5000);
    const full = { ...bag, extras: { ...bag.extras, ...short.extras } };
    s.store.save(instance.auth.serializeTokens(full));
    return { instance, bag: full };
}

test('the plug-in declares the SDK version, its label, and reads its config', () => {
    assert.equal(plugin.sdkVersion, SDK_VERSION);
    assert.equal(plugin.id, 'ts-live');
    assert.equal(plugin.label, 'Wimbledon');
    assert.equal(readConfig({ baseUrl: 'http://127.0.0.1:1/' }).baseUrl, 'http://127.0.0.1:1');
    assert.equal(readConfig({ baseUrl: 'http://x' }).pollIntervalMs, 2000);
    assert.throws(() => readConfig({}), /baseUrl/);
    assert.throws(() => readConfig({ baseUrl: 'http://x', pollIntervalMs: 0 }), /pollIntervalMs/);
});

test('sign-in, stream tokens and the stored record', async (t) => {
    const s = await start(t);
    const { auth } = s.site();
    await assert.rejects(auth.login({ email: 'viewer', password: 'wrong' }), SignInRefused);
    assert.equal(auth.classify(new SignInRefused('x')), 'needs-attention');

    const bag = await auth.login(ACCOUNT);
    assert.equal(claimsOf(bag.refreshToken).sub, 'acct-viewer');
    assert.ok(bag.sessionToken && bag.extras.deviceId);
    const short = await auth.fetchShortTokens(bag, 5000);
    assert.equal(short.extras.streamAccount, 'acct-viewer');
    assert.equal(Number(short.extras.streamExpires), Math.floor(s.clock.now() / 1000) + 10);

    const full = { ...bag, extras: { ...bag.extras, ...short.extras } };
    const record = auth.serializeTokens(full);
    assert.deepEqual(Object.keys(record).sort(), ['deviceId', 'refreshToken', 'sessionToken', 'streamAccount', 'streamExpires', 'streamToken']);
    assert.deepEqual(auth.deserializeTokens(JSON.parse(JSON.stringify(record))), full);
    assert.equal(auth.deserializeTokens({}), null);
    const described = auth.describeTokens(full);
    assert.equal(described.shortExpiresAt, Number(short.extras.streamExpires) * 1000);
    assert.equal(described.sessionExpiresAt, s.clock.now() - (s.clock.now() % 1000) + 3600_000);
    assert.equal(described.summary, `stream_expires=${short.extras.streamExpires}`);

    const stored = { record, writtenAtMs: s.clock.now(), readAtMs: s.clock.now() };
    assert.match(auth.headersFor(stored, 'api').cookie, /^session_token=/);
    assert.match(auth.headersFor(stored, 'stream').cookie, /^stream_token=.*; stream_account=acct-viewer; stream_expires=\d+$/);
    assert.throws(() => auth.headersFor({ ...stored, record: { ...record, streamToken: null } }, 'stream'), /stream tokens/);
    assert.throws(() => auth.headersFor({ ...stored, record: null }, 'api'), /session token/);
});

test('session renewal rotates the refresh token; a spent one, another device or a block page are told apart', async (t) => {
    const s = await start(t, { extra: { reuseRevokesFamily: true, faults: [{ type: 'refreshStatus', at: 600, until: 700, status: 403 }] } });
    const { auth } = s.site();
    const bag = await auth.login(ACCOUNT);
    const renewal = await auth.refreshSession(bag);
    assert.ok(renewal.newRefreshToken && renewal.newRefreshToken !== bag.refreshToken);
    assert.equal(claimsOf(renewal.newRefreshToken).gen, 2);

    // The spent token: rejected, and (as this site is configured) the whole family revoked.
    const spent = await auth.refreshSession(bag).catch((error) => error);
    assert.ok(spent instanceof SessionRejected);
    assert.equal(auth.classify(spent), 'reauthenticate');
    const revoked = await auth.refreshSession({ ...bag, refreshToken: renewal.newRefreshToken }).catch((error) => error);
    assert.equal(revoked.errorCode, 'SESSION_REVOKED');

    // A new sign-in starts a new family; a different device cookie asks for the check.
    const fresh = await auth.login(ACCOUNT);
    const challenge = await auth.refreshSession({ ...fresh, extras: { ...fresh.extras, deviceId: 'dev-other' } }).catch((error) => error);
    assert.ok(challenge instanceof ChallengeRequired);
    assert.equal(auth.classify(challenge), 'verification');

    // A block page without an error code is an outage: the tokens stay good.
    s.clock.set(EPOCH + 650_000);
    const blocked = await auth.refreshSession(fresh).catch((error) => error);
    assert.ok(!(blocked instanceof SessionRejected) && !(blocked instanceof ChallengeRequired));
    assert.equal(auth.classify(blocked), 'outage');
    s.clock.set(EPOCH + 710_000);
    assert.ok((await auth.refreshSession(fresh)).newSessionToken);
});

test('who is live: listed accounts only, the ended stream is terminal, a failed lookup is no answer', async (t) => {
    const s = await start(t, { extra: { extraRecords: true, faults: [{ type: 'apiStatus', api: 'live', at: 200, until: 210, status: 503 }] } });
    const { instance } = await signedIn(s);
    const capture = instance.capture;
    assert.equal(capture.mediaFormat, 'ts');
    assert.equal(capture.replaceSessionOnNewRecording, true);
    assert.equal(capture.pollIntervalMs, 2000);

    const targets = [{ id: 'acct-centre', label: 'centre-court' }, { id: 'acct-later', label: 'court-three' }];
    const first = await capture.lookup(targets, { recordingId: () => null });
    assert.deepEqual([...first.live.keys()], ['acct-centre']);
    const centre = first.live.get('acct-centre');
    assert.equal(centre.alias, 'centre-court');
    assert.match(centre.recordingId, /^\d+$/);
    assert.match(centre.masterPlaylistUrl, /\/hls\/\d+\/master\.m3u8$/);
    // acct-outer is live too, but not listed: ignored (the site adds it unasked).
    assert.deepEqual([...first.terminalTargetIds], ['acct-later']);

    // Within the end window the ended stream is reported ENDED: terminal.
    s.clock.set(EPOCH + 122_000);
    const ended = await capture.lookup(targets, { recordingId: () => null });
    assert.equal(ended.live.size, 0);
    assert.deepEqual([...ended.terminalTargetIds].sort(), ['acct-centre', 'acct-later']);

    // An API outage: no snapshot, never "all offline".
    s.clock.set(EPOCH + 205_000);
    assert.equal(await capture.lookup(targets, { recordingId: () => null }), null);

    // A new broadcast: a new recording identity.
    s.clock.set(EPOCH + 330_000);
    const again = await capture.lookup(targets, { recordingId: () => null });
    assert.notEqual(again.live.get('acct-centre').recordingId, centre.recordingId);

    // Signed out: the lookup cannot be made, which is no answer either.
    s.store.clear();
    assert.equal(await capture.lookup(targets, { recordingId: () => null }), null);
});

test('capture: the best variant, playlists with the stream tokens, 401 without them, 404 at the end', async (t) => {
    const s = await start(t);
    const { instance } = await signedIn(s);
    const { provider } = instance.capture;
    const snapshot = await instance.capture.lookup([{ id: 'acct-centre', label: 'centre-court' }], { recordingId: () => null });
    const master = snapshot.live.get('acct-centre').masterPlaylistUrl;

    const variant = await provider.parseMasterPlaylist(master);
    const streamHeaders = instance.auth.headersFor({ record: s.store.saved(), writtenAtMs: null, readAtMs: s.clock.now() }, 'stream');
    const masterBody = await (await fetch(master, { headers: streamHeaders })).text();
    const variants = parseVariants(masterBody, master);
    assert.ok(variants.length >= 1);
    assert.equal(variant, variants[0].url);
    assert.ok(!variant.endsWith('&'));
    assert.equal(provider.describeVariant(variant).isMasterBest, true);

    const session = provider.createDownloadSession();
    const playlist = await session.fetchPlaylist(variant);
    assert.match(playlist, /#EXTINF:/);
    const segment = playlist.split('\n').find((line) => line && !line.startsWith('#'));
    const fetched = await session.fetchSegment(new URL(segment, variant).href);
    assert.ok(fetched.data.length > 0);

    // The stream tokens expire after ten seconds; until the auth daemon renews them the
    // playlist answers 401, logged once.
    s.clock.advance(11_000);
    assert.equal(await session.fetchPlaylist(variant), null);
    assert.equal(await session.fetchPlaylist(variant), null);
    assert.deepEqual(session.getLastPlaylistFailure(), { kind: 'http', status: 401 });
    assert.equal(instance.lines.filter((line) => /Playlist 401 \(stream token expired\)/.test(line.message)).length, 1);
    await signedIn(s);
    assert.match(await session.fetchPlaylist(variant), /#EXTINF:/);
    assert.ok(instance.lines.some((line) => /authorized again after 2/.test(line.message)));

    // The stream ends; past its end window the playlist answers 404.
    s.clock.set(EPOCH + 140_000);
    await signedIn(s);
    await assert.rejects(session.fetchPlaylist(variant), PlaylistNotFoundError);

    // A retry reopens the same stream from the latest lookup, otherwise keeps the URL.
    const context = { streamerId: 'acct-centre', recordingId: snapshot.live.get('acct-centre').recordingId, exitReason: 'fetch-failed', lastMasterUrl: 'last', lastLiveUrl: variant };
    assert.equal(await provider.shouldRetry(context), master);
    assert.equal(await provider.shouldRetry({ ...context, recordingId: 'another-stream' }), 'last');
    assert.equal(await provider.shouldRetry({ ...context, exitReason: 'aborted' }), null);
});

test('catalog: list lines, finding accounts by ID, URL or any name, following, name refresh', async (t) => {
    const s = await start(t, { at: EPOCH + 150_000 });
    await signedIn(s);
    const { catalog, aliases } = s.site();

    assert.deepEqual(catalog.parseTargetLine('acct-centre show-court'), { id: 'acct-centre', label: 'show-court' });
    assert.equal(catalog.parseTargetLine('# comment'), null);
    assert.equal(catalog.parseTargetLine('   '), null);
    const warnings = [];
    assert.equal(catalog.parseTargetLine('acct-centre', (message) => warnings.push(message)), null);
    assert.equal(warnings.length, 1);
    assert.equal(catalog.formatTargetLine({ id: 'acct-centre', label: 'show-court' }), 'acct-centre show-court');
    assert.match(catalog.listHeader, /<accountId> <name>/);

    // By ID, by page URL, by current and by former name.
    assert.deepEqual(await catalog.resolveIdentifier('acct-centre'), { id: 'acct-centre', label: 'show-court' });
    assert.deepEqual(await catalog.resolveIdentifier(`${s.base}/outer-court`), { id: 'acct-outer', label: 'outer-court' });
    assert.deepEqual(await catalog.resolveIdentifier('centre-court'), { id: 'acct-centre', label: 'show-court' });
    assert.equal(await catalog.resolveIdentifier('nobody-here'), null);
    assert.deepEqual(aliases.names('acct-centre'), ['centre-court', 'show-court']);
    assert.equal(await catalog.exists('court-three'), true);
    assert.equal(await catalog.exists('nobody-here'), false);

    const listed = [{ id: 'acct-centre', label: 'show-court' }];
    assert.deepEqual(catalog.enrichList(listed).sort(), ['acct-centre', 'centre-court', 'show-court']);
    assert.equal(await catalog.resolveForRemove('centre-court', listed), 'acct-centre');
    assert.equal(await catalog.resolveForRemove(`${s.base}/acct-centre`, listed), 'acct-centre');
    assert.deepEqual(catalog.sourceLinks(listed[0]), { channelUrl: `${s.base}/acct-centre`, aliasUrl: `${s.base}/show-court` });

    // Adding follows the account on the site; the refresh reads followed and listed accounts.
    await catalog.beforeAdd({ id: 'acct-later', label: 'court-three' });
    const ids = await catalog.refreshAliases.ids(['acct-outer']);
    assert.deepEqual(ids.sort(), ['acct-centre', 'acct-later', 'acct-outer']);
    const names = await catalog.refreshAliases.run(ids);
    assert.deepEqual(names.get('acct-centre'), { current: 'show-court', history: ['centre-court'] });
    assert.equal(catalog.refreshAliases.keepHistory, true);
});

test('a phone gets its own token family, handed over once', async (t) => {
    const s = await start(t);
    const { auth } = s.site();
    const { cookies } = await auth.provisionDevice(ACCOUNT, 'phone-request-1');
    assert.deepEqual(cookies.map((cookie) => cookie.name), ['refresh_token', 'session_token', 'device_id']);
    const refresh = cookies[0];
    assert.equal(refresh.domain, '127.0.0.1');
    assert.equal(refresh.httpOnly, true);
    assert.equal(claimsOf(refresh.value).kind, 'device');

    // Asked again before the phone acknowledged: the same tokens.
    const again = await auth.provisionDevice(ACCOUNT, 'phone-request-1');
    assert.equal(again.cookies[0].value, refresh.value);
    await auth.acknowledgeDevice('phone-request-1');
    await assert.rejects(auth.provisionDevice(ACCOUNT, 'phone-request-1'), SessionRejected);
    await assert.rejects(auth.acknowledgeDevice('never-asked-1'), /UNKNOWN_REQUEST/);
});
