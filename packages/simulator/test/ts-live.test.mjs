import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { SimClock } from '../dist/clock.js';
import { startSimulator } from '../dist/serve.js';
import { peekClaims } from '../dist/sites/tokens.js';
import { TruthIndex } from '../dist/truth/query.js';
import { CookieClient, EPOCH, sharedLibrary, segmentsOf, variantsOf } from './helpers.mjs';

const ACCOUNT = { username: 'viewer', password: 'secret', accountId: 'acct-viewer' };

function scenario(extra = {}, channelExtra = {}) {
    return {
        name: 'ts-live test', seed: 'ts-seed', epoch: EPOCH,
        sites: { 'ts-live': {
            accounts: [ACCOUNT],
            channels: [
                { id: 'chan-centre', name: 'centre-court', schedule: { sessions: [{ start: 0, end: 120 }, { start: 300 }] }, endlistS: 6, renames: [{ at: 100, name: 'show-court' }], ...channelExtra },
                { id: 'chan-outer', name: 'outer-court', schedule: { sessions: [{ start: 1000 }] } },
            ],
            ...extra,
        } },
    };
}

async function start(t, extra, channelExtra, { at = EPOCH + 30_000 } = {}) {
    const media = await sharedLibrary();
    const clock = new SimClock({ mode: 'manual', at });
    const sim = await startSimulator({ scenario: scenario(extra, channelExtra), media: media.library, clock, autoPublish: false, memoryTruth: true });
    t.after(() => sim.close());
    return { sim, clock, base: sim.urls['ts-live'] };
}

async function signIn(base) {
    const client = new CookieClient(base);
    const res = await client.fetch('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=viewer&password=secret' });
    assert.equal(res.status, 303);
    return client;
}

const refresh = (client, rt = client.cookie('refresh_token')) => {
    const claims = peekClaims(rt);
    const c = new CookieClient(client.base);
    c.jar = new Map(client.jar);
    c.set('refresh_token', rt);
    return c.json('/api/session/refresh', { accountId: claims.sub, sessionId: claims.sid }).then(async res => ({ res, body: await res.json(), client: c }));
};

test('login, live lookup, master with variants, media playlist and segments', async (t) => {
    const { sim, base } = await start(t);
    const page = await fetch(base + '/login');
    assert.match(await page.text(), /data-testid="login-submit"/);
    const wrong = await fetch(base + '/login', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ username: 'viewer', password: 'nope' }) });
    assert.equal(wrong.status, 401);
    assert.deepEqual(await wrong.json(), { errorCode: 'BAD_CREDENTIALS' });

    const client = await signIn(base);
    assert.ok(client.cookie('refresh_token') && client.cookie('session_token') && client.cookie('device_id'));

    // Live lookup: records only for requested, live accounts.
    let res = await client.json('/api/live/by-account-ids?pageSize=10', { accountIds: ['chan-centre', 'chan-outer'] });
    const live = await res.json();
    assert.equal(live.totalCount, 1);
    const stream = live.records[0].stream;
    assert.equal(stream.accountId, 'chan-centre');
    assert.equal(stream.status, 'LIVE');
    assert.match(stream.id, /^\d+$/);
    res = await client.json('/api/live/by-account-ids', { accountIds: ['chan-outer'] });
    assert.deepEqual(await res.json(), { code: 'OK', totalCount: 0 }, 'empty answers omit records');
    res = await fetch(base + '/api/live/by-account-ids', { method: 'POST', body: '{}' });
    assert.equal(res.status, 401, 'the lookup needs a session token');

    // The master needs a stream token.
    res = await client.fetch(stream.masterUrl);
    assert.equal(res.status, 401);
    res = await client.fetch('/api/stream/token');
    assert.equal(res.status, 200);
    assert.ok(Number(client.cookie('stream_expires')) * 1000 > EPOCH + 30_000);
    res = await client.fetch(stream.masterUrl);
    assert.equal(res.status, 200);
    const variants = variantsOf(await res.text());
    assert.equal(variants.length, 2);
    assert.ok(variants[0].width * variants[0].height < variants[1].width * variants[1].height, 'lowest first');
    assert.ok(variants.every(v => v.uri.endsWith('&')), 'variant URIs end with &');
    const best = variants.reduce((a, b) => a.width * a.height >= b.width * b.height ? a : b);

    res = await client.fetch(best.uri);
    assert.equal(res.status, 200);
    const media = segmentsOf(await res.text());
    assert.equal(media.segments.length, 6);
    assert.equal(media.ended, false);
    // Segments need no token.
    const plain = await fetch(base + media.segments.at(-1).uri);
    assert.equal(plain.status, 200);
    assert.equal(plain.headers.get('content-type'), 'video/mp2t');
    const bytes = Buffer.from(await plain.arrayBuffer());
    assert.equal(bytes[0], 0x47);

    // The ground truth agrees with what was served.
    sim.sim.publisher.tick();
    const truth = new TruthIndex(sim.memory.records);
    const listed = truth.listedAt({ site: 'ts-live', channel: 'chan-centre', tier: 'ts' }, EPOCH + 30_000);
    assert.deepEqual(listed.map(s => s.seq), media.segments.map(s => s.seq));
    assert.equal(listed.at(-1).sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(truth.sessions({ site: 'ts-live' })[0].recordingId, stream.id, 'the recording identity is the stream id');
    const served = truth.responses({ site: 'ts-live', kind: 'segment' });
    assert.equal(served.at(-1).status, 200);
    assert.equal(served.at(-1).sha256, listed.at(-1).sha256);
});

test('an expired stream token gets 401; a new one gets 200; a revoke cuts tokens early', async (t) => {
    const { clock, base } = await start(t, { faults: [{ type: 'tokenRevoke', at: 60 }] });
    const client = await signIn(base);
    const live = await (await client.json('/api/live/by-account-ids', { accountIds: ['chan-centre'] })).json();
    const masterUrl = live.records[0].stream.masterUrl;
    await client.fetch('/api/stream/token');
    const variants = variantsOf(await (await client.fetch(masterUrl)).text());
    const uri = variants.at(-1).uri;
    assert.equal((await client.fetch(uri)).status, 200);
    clock.advance(11_000);
    const expired = await client.fetch(uri);
    assert.equal(expired.status, 401);
    assert.equal((await expired.json()).reason, 'expired');
    assert.equal((await client.fetch('/api/stream/token')).status, 200);
    assert.equal((await client.fetch(uri)).status, 200);
    // At 60 s every stream token issued before then stops working.
    clock.set(EPOCH + 58_000);
    await client.fetch('/api/stream/token');
    clock.set(EPOCH + 61_000);
    const revoked = await client.fetch(uri);
    assert.equal(revoked.status, 401);
    assert.equal((await revoked.json()).reason, 'revoked');
    await client.fetch('/api/stream/token');
    assert.equal((await client.fetch(uri)).status, 200);
});

test('refresh rotates the refresh token: the old one stops working, the new one works once', async (t) => {
    const { clock, base } = await start(t);
    const client = await signIn(base);
    const rt1 = client.cookie('refresh_token');
    clock.advance(1000);
    const first = await refresh(client, rt1);
    assert.equal(first.res.status, 200);
    const rt2 = first.client.cookie('refresh_token');
    assert.notEqual(rt2, rt1);
    assert.ok(first.client.cookie('session_token'));
    const reuse = await refresh(client, rt1);
    assert.equal(reuse.res.status, 401);
    assert.equal(reuse.body.errorCode, 'INVALID_TOKEN');
    const second = await refresh(client, rt2);
    assert.equal(second.res.status, 200);
    // Without the device cookie the site asks for a challenge.
    const noDevice = new CookieClient(base);
    noDevice.set('refresh_token', second.client.cookie('refresh_token'));
    const claims = peekClaims(second.client.cookie('refresh_token'));
    const challenged = await noDevice.json('/api/session/refresh', { accountId: claims.sub, sessionId: claims.sid });
    assert.equal(challenged.status, 424);
    assert.equal((await challenged.json()).errorCode, 'CHALLENGE_REQUIRED');
    // The body must name the token's account and session.
    const c = new CookieClient(base);
    c.jar = new Map(second.client.jar);
    assert.equal((await c.json('/api/session/refresh', { accountId: 'someone', sessionId: claims.sid })).status, 400);
    // The new session token works for the API.
    assert.equal((await second.client.fetch('/api/followings?size=10')).status, 200);
});

test('reuse can revoke the whole family when the scenario says so', async (t) => {
    const { base } = await start(t, { reuseRevokesFamily: true });
    const client = await signIn(base);
    const rt1 = client.cookie('refresh_token');
    const first = await refresh(client, rt1);
    assert.equal((await refresh(client, rt1)).body.errorCode, 'SESSION_REVOKED');
    assert.equal((await refresh(first.client)).body.errorCode, 'SESSION_REVOKED');
});

test('a phone gets its own token family; provisioning is idempotent until acknowledged', async (t) => {
    const { base } = await start(t);
    const web = await signIn(base);
    const one = await web.json('/api/device/provision', { requestId: 'phone-request-1' });
    assert.equal(one.status, 200);
    const creds = await one.json();
    const again = await (await web.json('/api/device/provision', { requestId: 'phone-request-1' })).json();
    assert.deepEqual(again, creds, 'a retry before acknowledgement returns the same credentials');
    assert.notEqual(creds.sessionId, peekClaims(web.cookie('refresh_token')).sid, 'a separate family');

    const phone = new CookieClient(base);
    phone.set('refresh_token', creds.refreshToken);
    phone.set('device_id', creds.deviceId);
    const rotated = await phone.json('/api/session/refresh', { accountId: creds.accountId, sessionId: creds.sessionId });
    assert.equal(rotated.status, 200);
    const phoneBody = await rotated.json();
    assert.ok(phoneBody.refreshToken && phoneBody.refreshToken !== creds.refreshToken);
    // The web family is untouched by the phone's rotation, and vice versa.
    const webRotated = await refresh(web);
    assert.equal(webRotated.res.status, 200);
    const phone2 = new CookieClient(base);
    phone2.set('refresh_token', phoneBody.refreshToken);
    phone2.set('device_id', creds.deviceId);
    assert.equal((await phone2.json('/api/session/refresh', { accountId: creds.accountId, sessionId: creds.sessionId })).status, 200);

    assert.equal((await web.json('/api/device/acknowledge', { requestId: 'phone-request-1' })).status, 200);
    assert.equal((await web.json('/api/device/acknowledge', { requestId: 'phone-request-1' })).status, 200, 'acknowledging twice is fine');
    const late = await web.json('/api/device/provision', { requestId: 'phone-request-1' });
    assert.equal(late.status, 409);
});

test('refresh faults: an error code means sign in again, a bare block page is an outage', async (t) => {
    const { clock, base } = await start(t, { faults: [
        { type: 'refreshStatus', at: 40, until: 50, status: 403, errorCode: 'SESSION_EXPIRED' },
        { type: 'refreshStatus', at: 50, until: 60, status: 403 },
    ] });
    const client = await signIn(base);
    clock.set(EPOCH + 45_000);
    const coded = await refresh(client);
    assert.equal(coded.res.status, 403);
    assert.equal(coded.body.errorCode, 'SESSION_EXPIRED');
    clock.set(EPOCH + 55_000);
    const c = new CookieClient(base);
    c.jar = new Map(client.jar);
    const claims = peekClaims(client.cookie('refresh_token'));
    const blocked = await c.json('/api/session/refresh', { accountId: claims.sub, sessionId: claims.sid });
    assert.equal(blocked.status, 403);
    assert.match(blocked.headers.get('content-type'), /text\/html/);
    clock.set(EPOCH + 61_000);
    assert.equal((await refresh(client)).res.status, 200, 'the token survived both');
});

test('a stream that ended lists ENDLIST, then its playlists answer 404', async (t) => {
    const { clock, base } = await start(t, {}, {}, { at: EPOCH + 110_000 });
    const client = await signIn(base);
    const live = await (await client.json('/api/live/by-account-ids', { accountIds: ['chan-centre'] })).json();
    const { masterUrl, id } = live.records[0].stream;
    await client.fetch('/api/stream/token');
    const uri = variantsOf(await (await client.fetch(masterUrl)).text()).at(-1).uri;
    clock.set(EPOCH + 121_000);
    await client.fetch('/api/stream/token');
    const last = segmentsOf(await (await client.fetch(uri)).text());
    assert.equal(last.ended, true);
    const ended = await (await client.json('/api/live/by-account-ids', { accountIds: ['chan-centre'] })).json();
    assert.equal(ended.records[0].stream.status, 'ENDED');
    clock.set(EPOCH + 127_000);
    await client.fetch('/api/stream/token');
    assert.equal((await client.fetch(uri)).status, 404);
    assert.equal((await client.fetch(masterUrl)).status, 404);
    assert.deepEqual(await (await client.json('/api/live/by-account-ids', { accountIds: ['chan-centre'] })).json(), { code: 'OK', totalCount: 0 });
    // The next session is a new stream id.
    clock.set(EPOCH + 310_000);
    await client.fetch('/api/stream/token');
    const next = await (await client.json('/api/live/by-account-ids', { accountIds: ['chan-centre'] })).json();
    assert.notEqual(next.records[0].stream.id, id);
});

test('catalog: profiles with renames, followings, follow, and API faults', async (t) => {
    const { clock, base } = await start(t, { extraRecords: true, faults: [
        { type: 'apiStatus', at: 200, until: 210, status: 503, api: 'live' },
        { type: 'apiStatus', at: 210, until: 220, status: 'malformed', api: 'live' },
    ] }, {}, { at: EPOCH + 30_000 });
    const client = await signIn(base);
    let res = await client.json('/api/profiles/batch', ['chan-centre', 'outer-court', 'nobody']);
    let body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['chan-centre', 'outer-court']);
    assert.equal(body['chan-centre'].profile.aliases[0].alias, 'centre-court');
    clock.set(EPOCH + 101_000);
    body = await (await client.json('/api/profiles/batch', ['centre-court'])).json();
    assert.deepEqual(body['centre-court'].profile.aliases.map(a => a.alias), ['show-court', 'centre-court'], 'current alias first');
    body = await (await client.fetch('/api/followings?size=5000')).json();
    assert.deepEqual(body.following.map(f => f.accountId).sort(), ['chan-centre', 'chan-outer']);
    assert.equal((await client.fetch('/api/follow', { method: 'POST', body: 'nobody' })).status, 404);
    // An unrequested live record shows up; clients must ignore it.
    clock.set(EPOCH + 1100_000);
    await refresh(client).then(r => { client.jar = r.client.jar; });
    body = await (await client.json('/api/live/by-account-ids', { accountIds: ['chan-centre'] })).json();
    assert.deepEqual(body.records.map(r => r.stream.accountId).sort(), ['chan-centre', 'chan-outer']);
    clock.set(EPOCH + 205_000);
    assert.equal((await client.json('/api/live/by-account-ids', { accountIds: ['chan-centre'] })).status, 503);
    clock.set(EPOCH + 215_000);
    res = await client.json('/api/live/by-account-ids', { accountIds: ['chan-centre'] });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).code, undefined, 'a malformed answer is not the authoritative empty one');
});

test('a channel can answer the master URL with its media playlist', async (t) => {
    const { base } = await start(t, {}, { mediaAsMaster: true });
    const client = await signIn(base);
    const live = await (await client.json('/api/live/by-account-ids', { accountIds: ['chan-centre'] })).json();
    await client.fetch('/api/stream/token');
    const text = await (await client.fetch(live.records[0].stream.masterUrl)).text();
    assert.match(text, /#EXT-X-MEDIA-SEQUENCE/);
    assert.doesNotMatch(text, /#EXT-X-STREAM-INF/);
});
