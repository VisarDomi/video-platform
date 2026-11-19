import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { SimClock } from '../dist/clock.js';
import { startSimulator } from '../dist/serve.js';
import { EPOCH, makeVideo, sharedLibrary, tempDir } from './helpers.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const CLIENT = { client_id: 'sim-client', client_secret: 'sim-secret' };
const CHUNK = 256 * 1024;

let clip = null;
function testClip() {
    clip ??= (() => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'sim-api-clip-'));
        process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
        makeVideo(path.join(dir, 'clip.mp4'), { seconds: 4, size: '640x360', audio: 'aac' });
        return readFileSync(path.join(dir, 'clip.mp4'));
    })();
    return clip;
}

async function start(t, extra = {}, { stateDir = null, clock = new SimClock({ mode: 'manual', at: EPOCH + 10_000 }) } = {}) {
    const media = await sharedLibrary();
    const sim = await startSimulator({
        scenario: { name: 'api', seed: 'api-seed', epoch: EPOCH, sites: { 'api-host': { accounts: [{ username: 'coach', password: 'pw' }, { username: 'other', password: 'pw' }], processingS: 60, ...extra } } },
        media: media.library, clock, autoPublish: false, memoryTruth: true, stateDir,
    });
    let open = true;
    t.after(() => open && sim.close());
    return { sim, clock, base: sim.urls['api-host'], close: async () => { open = false; await sim.close(); } };
}

const form = (base, body) => fetch(base + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
const login = async (base, username = 'coach') => (await form(base, { grant_type: 'password', username, password: 'pw', ...CLIENT })).json();
const api = (base, token, p, init = {}) => fetch(base + p, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
const createVideo = (base, token, { title = 'Semi final', total, clientRef, tags = ['tennis'] } = {}) => api(base, token, '/upload/v1/videos?uploadType=resumable', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-upload-content-length': String(total), 'x-upload-content-type': 'video/mp4' },
    body: JSON.stringify({ snippet: { title, description: 'Five sets.', tags, categoryId: '17' }, status: { privacyStatus: 'public' }, ...(clientRef ? { clientRef } : {}) }),
});
const putRange = (url, token, bytes, start, end, total) => fetch(url, {
    method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-range': `bytes ${start}-${end}/${total}` }, body: bytes.subarray(start, end + 1),
});
const queryOffset = (url, token, total) => fetch(url, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-range': `bytes */${total}` } });

/** Uploads everything in CHUNK pieces, resuming from the server's offset. */
async function uploadAll(url, token, bytes) {
    let offset = 0;
    for (;;) {
        const end = Math.min(bytes.length, offset + CHUNK) - 1;
        const res = await putRange(url, token, bytes, offset, end, bytes.length);
        if (res.status === 200 || res.status === 201) return res;
        assert.equal(res.status, 308);
        offset = Number(/bytes=0-(\d+)/.exec(res.headers.get('range'))[1]) + 1;
    }
}

test('tokens: password and refresh grants, 401 invalid_token, rotation with reuse detection, scripted revocation', async (t) => {
    const { base, clock } = await start(t, { accessTokenTtlS: 600, rotateRefreshTokens: true, faults: [{ type: 'revokeTokens', at: 5000, account: 'coach' }] });
    assert.equal((await form(base, { grant_type: 'password', username: 'coach', password: 'pw', client_id: 'sim-client', client_secret: 'nope' })).status, 401);
    let res = await form(base, { grant_type: 'password', username: 'coach', password: 'bad', ...CLIENT });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_grant');
    const tokens = await login(base);
    assert.equal(tokens.token_type, 'Bearer');
    assert.equal(tokens.expires_in, 600);

    res = await fetch(base + '/v1/me');
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate'), /error="invalid_token"/);
    assert.equal((await res.json()).error.errors[0].reason, 'invalid_token');
    res = await api(base, tokens.access_token, '/v1/me');
    assert.deepEqual(await res.json(), { id: 'coach', username: 'coach' });

    clock.advance(601_000);
    res = await api(base, tokens.access_token, '/v1/me');
    assert.equal((await res.json()).error.errors[0].reason, 'expired_token');
    res = await form(base, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, ...CLIENT });
    const second = await res.json();
    assert.equal(res.status, 200);
    assert.notEqual(second.refresh_token, tokens.refresh_token, 'rotated');
    assert.equal((await api(base, second.access_token, '/v1/me')).status, 200);
    // Reusing the spent refresh token revokes the family.
    res = await form(base, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, ...CLIENT });
    assert.equal((await res.json()).error, 'invalid_grant');
    assert.equal((await form(base, { grant_type: 'refresh_token', refresh_token: second.refresh_token, ...CLIENT })).status, 400);
    assert.equal((await (await api(base, second.access_token, '/v1/me')).json()).error.errors[0].reason, 'revoked_token');

    // A scripted revocation at 5000 s signs every earlier family out.
    const third = await login(base);
    const otherUser = await login(base, 'other');
    clock.set(EPOCH + 5_001_000);
    assert.equal((await form(base, { grant_type: 'refresh_token', refresh_token: third.refresh_token, ...CLIENT })).status, 400);
    assert.equal((await api(base, third.access_token, '/v1/me')).status, 401);
    assert.equal((await form(base, { grant_type: 'refresh_token', refresh_token: otherUser.refresh_token, ...CLIENT })).status, 200, 'only the named account');
    const info = await (await fetch(`${base}/oauth/tokeninfo?access_token=${(await login(base)).access_token}`)).json();
    assert.equal(info.sub, 'coach');
});

test('resumable upload: the id exists at create; 308 with Range; offset queries; idempotent create; processing to ready', async (t) => {
    const bytes = testClip();
    const { base, clock, sim } = await start(t);
    const { access_token: token } = await login(base);
    let res = await createVideo(base, token, { total: bytes.length, clientRef: '[2026-06-01 120000 centre]' });
    assert.equal(res.status, 200);
    const created = await res.json();
    const url = res.headers.get('location');
    assert.equal(created.uploadUrl, url);
    assert.equal(res.headers.get('x-video-id'), created.id);
    assert.equal(created.status.uploadStatus, 'uploading');
    assert.equal((await (await api(base, token, `/v1/videos/${created.id}`)).json()).status.uploadStatus, 'uploading', 'the video exists from the create on');

    res = await putRange(url, token, bytes, 0, CHUNK - 1, bytes.length);
    assert.equal(res.status, 308);
    assert.equal(res.headers.get('range'), `bytes=0-${CHUNK - 1}`);
    res = await queryOffset(url, token, bytes.length);
    assert.equal(res.status, 308);
    assert.equal(res.headers.get('range'), `bytes=0-${CHUNK - 1}`);
    res = await putRange(url, token, bytes, CHUNK + 10, CHUNK + 20, bytes.length);
    assert.equal(res.status, 400, 'a range past the received bytes');
    assert.equal((await res.json()).error.errors[0].expectedOffset, CHUNK);
    // An overlapping retry is fine: only the new bytes count.
    res = await putRange(url, token, bytes, CHUNK - 100, Math.min(bytes.length, 2 * CHUNK) - 1, bytes.length);
    assert.ok([308, 201].includes(res.status));

    // A crash between create and persist: the same clientRef finds the same video and session.
    res = await createVideo(base, token, { total: bytes.length, clientRef: '[2026-06-01 120000 centre]' });
    assert.equal(res.headers.get('x-idempotent-replay'), 'true');
    assert.equal((await res.json()).id, created.id);
    const byRef = await (await api(base, token, `/v1/videos?clientRef=${encodeURIComponent('[2026-06-01 120000 centre]')}`)).json();
    assert.deepEqual(byRef.items.map(v => v.id), [created.id]);

    res = await uploadAll(url, token, bytes);
    assert.equal(res.status, 201);
    const done = await res.json();
    assert.equal(done.status.uploadStatus, 'processing');
    assert.equal(done.fileDetails.sha256, sha(bytes));
    assert.equal(done.fileDetails.width, 640);
    assert.equal((await queryOffset(url, token, bytes.length)).status, 200, 'a finished session answers 200');

    clock.advance(61_000);
    const ready = await (await api(base, token, `/v1/videos/${created.id}`)).json();
    assert.equal(ready.status.uploadStatus, 'ready');
    assert.deepEqual(ready.renditions.map(r => `${r.height}:${r.width}`), ['360:640']);
    res = await fetch(ready.renditions[0].url, { headers: { range: 'bytes=10-19' } });
    assert.equal(res.status, 206);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(bytes.subarray(10, 20)));
    assert.equal((await fetch(ready.watchUrl)).status, 200);
    const uploaded = sim.memory.records.find(r => r.event === 'video-uploaded');
    assert.equal(uploaded.sha256, sha(bytes));
    assert.equal(uploaded.processedAt, EPOCH + 10_000 + 0 + 60_000);
});

test('a dropped upload request stores part of the body; the client resumes from the reported offset', async (t) => {
    const bytes = testClip();
    const { base, clock } = await start(t, { faults: [{ type: 'uploadFault', at: 100, until: 110, mode: 'drop' }] });
    const { access_token: token } = await login(base);
    const created = await createVideo(base, token, { total: bytes.length });
    const url = created.headers.get('location');
    clock.set(EPOCH + 105_000);
    const raw = await new Promise(resolve => {
        const u = new URL(url);
        const req = http.request(u, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-range': `bytes 0-${CHUNK - 1}/${bytes.length}`, 'content-length': CHUNK } });
        req.on('response', r => resolve(r.statusCode));
        req.on('error', e => resolve(e.code));
        req.end(bytes.subarray(0, CHUNK));
    });
    assert.ok(typeof raw === 'string', `the connection was dropped (${raw})`);
    clock.set(EPOCH + 111_000);
    const res = await queryOffset(url, token, bytes.length);
    assert.equal(res.status, 308);
    assert.equal(res.headers.get('range'), `bytes=0-${CHUNK / 2 - 1}`, 'half of the body arrived');
    const done = await (await uploadAll(url, token, bytes)).json();
    assert.equal(done.fileDetails.sha256, sha(bytes), 'resumed without a gap or an overlap');
});

test('list paging, deletion, rejection and removal rules, banned terms, duration limits', async (t) => {
    const bytes = testClip();
    const { base, clock, sim } = await start(t, {
        processingS: 0, minDurationS: 10, bannedWords: [{ word: 'Brandname' }],
        removals: [{ titleMatches: 'reject', afterS: 30, kind: 'rejected', reason: 'rights holder' }, { titleMatches: 'vanish', afterS: 30 }],
    });
    const { access_token: token } = await login(base);
    let res = await createVideo(base, token, { title: 'Brandname open', total: 10, tags: ['ok', 'Brandname'] });
    assert.equal(res.status, 422);
    assert.deepEqual((await res.json()).error.errors.map(e => `${e.field}:${e.term}`), ['snippet.title:Brandname', 'snippet.tags[1]:Brandname']);
    const ids = [];
    for (const title of ['First', 'Please reject', 'Will vanish']) {
        clock.advance(1000);
        res = await createVideo(base, token, { title, total: bytes.length });
        const v = await res.json();
        ids.push(v.id);
        await uploadAll(v.uploadUrl, token, bytes);
    }
    let page = await (await api(base, token, '/v1/videos?pageSize=2')).json();
    assert.equal(page.totalResults, 3);
    assert.deepEqual(page.items.map(v => v.id), [ids[2], ids[1]]);
    const next = await (await api(base, token, `/v1/videos?pageSize=2&pageToken=${page.nextPageToken}`)).json();
    assert.deepEqual(next.items.map(v => v.id), [ids[0]]);
    assert.equal(next.nextPageToken, undefined);

    // A 4 s clip is below the 10 s minimum: processing fails with a reason.
    clock.advance(1000);
    let v = await (await api(base, token, `/v1/videos/${ids[0]}`)).json();
    assert.equal(v.status.uploadStatus, 'failed');
    assert.equal(v.status.failureReason, 'durationTooShort');

    res = await api(base, token, `/v1/videos/${ids[0]}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snippet: { title: 'Brandname' } }) });
    assert.equal(res.status, 422);
    res = await api(base, token, `/v1/videos/${ids[0]}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snippet: { title: 'Renamed' } }) });
    assert.equal((await res.json()).snippet.title, 'Renamed');

    clock.advance(31_000);
    v = await (await api(base, token, `/v1/videos/${ids[1]}`)).json();
    assert.equal(v.status.uploadStatus, 'rejected');
    assert.equal(v.status.rejectionReason, 'rights holder');
    res = await api(base, token, `/v1/videos/${ids[2]}`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.errors[0].reason, 'videoNotFound');
    assert.equal((await api(base, token, `/v1/videos/${ids[0]}`, { method: 'DELETE' })).status, 204);
    assert.equal((await api(base, token, `/v1/videos/${ids[0]}`)).status, 404);
    page = await (await api(base, token, '/v1/videos')).json();
    assert.deepEqual(page.items.map(x => x.id), [ids[1]], 'deleted and removed videos leave the list; rejected ones stay');
    assert.ok(sim.memory.records.some(r => r.event === 'video-deleted' && r.video === ids[0]));
});

test('a daily quota answers 403 quotaExceeded and resets with the UTC day', async (t) => {
    const { base, clock, sim } = await start(t, { quota: { dailyUnits: 105, costs: { insert: 100 } } });
    const { access_token: token } = await login(base);
    assert.equal((await createVideo(base, token, { total: 100 })).status, 200);
    for (let i = 0; i < 5; i++) assert.equal((await api(base, token, '/v1/videos')).status, 200);
    let res = await api(base, token, '/v1/videos');
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error.errors[0].reason, 'quotaExceeded');
    assert.equal(body.error.errors[0].domain, 'usageLimits');
    assert.equal((await (await api(base, token, '/v1/limits')).json()).quota.used, 105, 'limits are free');
    clock.set(Date.parse('2026-06-02T00:00:01Z'));
    assert.equal((await api(base, (await login(base)).access_token, '/v1/videos')).status, 200, 'a new day, a new budget');
    assert.ok(sim.memory.records.some(r => r.event === 'quota-exceeded'));
});

test('tokens, quota use and a half-done upload survive a restart', async (t) => {
    const bytes = testClip();
    const stateDir = path.join(tempDir(t), 'state');
    const clock = new SimClock({ mode: 'manual', at: EPOCH + 10_000 });
    const first = await start(t, { quota: { dailyUnits: 1000 } }, { stateDir, clock });
    const tokens = await login(first.base);
    const created = await createVideo(first.base, tokens.access_token, { total: bytes.length });
    const url = created.headers.get('location');
    await putRange(url, tokens.access_token, bytes, 0, CHUNK - 1, bytes.length);
    await first.close();

    const second = await start(t, { quota: { dailyUnits: 1000 } }, { stateDir, clock });
    const resumeUrl = url.replace(first.base, second.base);
    const res = await queryOffset(resumeUrl, tokens.access_token, bytes.length);
    assert.equal(res.status, 308, 'the access token still works');
    assert.equal(res.headers.get('range'), `bytes=0-${CHUNK - 1}`);
    const done = await (await uploadAll(resumeUrl, tokens.access_token, bytes)).json();
    assert.equal(done.fileDetails.sha256, sha(bytes));
    assert.equal((await form(second.base, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, ...CLIENT })).status, 200);
    const state = await (await fetch(second.sim.urls.control + '/state')).json();
    assert.equal(state.sites['api-host'].quota.used, 100 + 0);
});
