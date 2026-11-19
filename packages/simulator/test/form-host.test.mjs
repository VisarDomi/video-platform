import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SimClock } from '../dist/clock.js';
import { startSimulator } from '../dist/serve.js';
import { qualityTiers } from '../dist/sites/videos.js';
import { CookieClient, EPOCH, makeVideo, sharedLibrary, tempDir } from './helpers.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');

let clips = null;
/** A small clip, a full-HD clip and bytes that are not a video (generated once per process). */
function testClips() {
    clips ??= (() => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'sim-clips-'));
        process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
        makeVideo(path.join(dir, 'small.mp4'), { seconds: 3, audio: 'aac' });
        makeVideo(path.join(dir, 'fullhd.mp4'), { seconds: 1, size: '1920x1080', audio: 'aac' });
        return {
            small: readFileSync(path.join(dir, 'small.mp4')),
            fullhd: readFileSync(path.join(dir, 'fullhd.mp4')),
            junk: Buffer.alloc(150_000, 7),
        };
    })();
    return clips;
}

function scenario(extra = {}) {
    return {
        name: 'form', seed: 'form-seed', epoch: EPOCH,
        sites: { 'form-host': {
            accounts: [{ username: 'coach', password: 'pw', displayName: 'Coach' }, { username: 'umpire', password: 'pw2' }],
            processingS: 120, chunkSize: 65536, rotateSessionS: 3600, rotationGraceS: 30, listTotalsLagS: 60, removalLagS: 60,
            ...extra,
        } },
    };
}

async function start(t, extra, { stateDir = null, clock = new SimClock({ mode: 'manual', at: EPOCH + 10_000 }) } = {}) {
    const media = await sharedLibrary();
    const sim = await startSimulator({ scenario: scenario(extra), media: media.library, clock, autoPublish: false, memoryTruth: true, stateDir });
    let open = true;
    t.after(() => open && sim.close());
    return { sim, clock, base: sim.urls['form-host'], close: async () => { open = false; await sim.close(); }, events: name => sim.memory.records.filter(r => r.type === 'event' && r.event === name) };
}

const field = (page, name) => new RegExp(`name="${name.replace(/[[\]]/g, '\\$&')}" value="([^"]*)"`).exec(page)?.[1];

async function signIn(base, username = 'coach', password = 'pw', { remember = false, client = new CookieClient(base) } = {}) {
    const page = await (await client.fetch('/login/')).text();
    const body = new URLSearchParams({ action: 'login', csrf_token: field(page, 'csrf_token'), username, pass: password });
    if (remember) body.set('remember_me', '1');
    const res = await client.fetch('/login/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    assert.equal(res.status, 302, 'signed in');
    return client;
}

/** What the upload page's own script does: chunks, retries at the same index, finish. */
async function transfer(client, bytes, { chunkSize = 65536, retries = 3, onRetry = () => {} } = {}) {
    const page = await (await client.fetch('/upload-video/')).text();
    const token = field(page, 'upload_token');
    const csrf = field(page, 'csrf_token');
    const total = Math.max(1, Math.ceil(bytes.length / chunkSize));
    const attempts = [];
    for (let i = 0; i < total; i++) {
        for (let attempt = 1; ; attempt++) {
            const fd = new FormData();
            fd.append('upload_token', token); fd.append('index', String(i)); fd.append('total', String(total));
            fd.append('content', new Blob([bytes.subarray(i * chunkSize, (i + 1) * chunkSize)]), 'clip.mp4');
            let ok = false;
            try {
                const res = await client.fetch('/upload-video/?mode=async&action=upload_file', { method: 'POST', body: fd });
                ok = res.status === 200 && (await res.json()).status === 'success';
            } catch { ok = false; }
            attempts.push({ index: i, attempt, ok });
            if (ok) break;
            if (attempt >= retries) throw new Error(`chunk ${i} failed ${attempt} times`);
            onRetry(i);
        }
    }
    const fin = new URLSearchParams({ upload_token: token, total: String(total), filesize: String(bytes.length), filename: 'clip.mp4' });
    const res = await client.fetch('/upload-video/?mode=async&action=finish_upload', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: fin });
    const done = await res.json();
    assert.equal(done.status, 'success', JSON.stringify(done));
    return { fileToken: done.file_token, csrf, attempts };
}

async function submit(client, { fileToken, csrf }, meta) {
    const body = new URLSearchParams({ action: 'add_video', csrf_token: csrf, file_token: fileToken, title: meta.title, description: meta.description ?? 'A full match.', tags: meta.tags ?? 'tennis, final', is_private: meta.private ? '1' : '0' });
    for (const c of meta.categories ?? ['21']) body.append('category_ids[]', c);
    const res = await client.fetch('/upload-video/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    return { status: res.status, page: await res.text() };
}

const rows = page => [...page.matchAll(/<div class="item([^"]*)" data-item-id="(\d+)"><p class="inf">(?:<a href="([^"]*)">|<span)/g)]
    .map(m => ({ id: m[2], cls: m[1].trim(), href: m[3] ?? null }));
const tabs = page => ({ public: Number(/Public \((\d+)\)/.exec(page)[1]), private: Number(/Private \((\d+)\)/.exec(page)[1]) });
const heading = page => Number(/<h2>My Videos \((\d+)\)<\/h2>/.exec(page)?.[1]);
const block = n => `/my/videos/?mode=async&function=get_block&block_id=list_videos_my_uploaded_videos&sort_by=&from_my_videos=${n}`;

test('consent wall, CSRF login, one session per account, remember-me, rotation and forced logout', async (t) => {
    const { base, clock } = await start(t, { faults: [{ type: 'logout', at: 7200, account: 'coach' }] });
    let page = await (await fetch(base + '/')).text();
    assert.equal([...page.matchAll(/id="okButton"/g)].length, 1);
    assert.match(page, /id="overlay"/);
    const consent = await fetch(base + '/consent/', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ back: '/login/' }) });
    assert.equal(consent.status, 303);
    assert.match(consent.headers.get('set-cookie'), /consent=1/);

    const guest = new CookieClient(base);
    guest.set('consent', '1');
    page = await (await guest.fetch('/login/')).text();
    assert.doesNotMatch(page, /id="overlay"/);
    assert.equal([...page.matchAll(/type="password" name="pass"/g)].length, 1, 'one password input named pass');
    assert.match(page, /id="reset_password_form"[^>]*style="display:none"/);
    let res = await guest.fetch('/login/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf_token: 'forged', username: 'coach', pass: 'pw' }) });
    assert.equal(res.status, 403);
    res = await guest.fetch('/login/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf_token: field(page, 'csrf_token'), username: 'coach', pass: 'nope' }) });
    assert.match(await res.text(), /Wrong username or password/);

    // Signed out: a redirect to the login page; signed in: the upload form.
    res = await guest.fetch('/upload-video/');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login/');
    const a = await signIn(base, 'coach', 'pw', { remember: true });
    page = await (await a.fetch('/')).text();
    assert.match(page, /Hello, Coach/);
    res = await a.fetch('/upload-video/');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<input type="file" name="content"/);

    // A second password login signs the first session out.
    const b = await signIn(base, 'coach', 'pw');
    assert.equal((await b.fetch('/upload-video/')).status, 200);
    const aSid = a.cookie('sid');
    res = await a.fetch('/upload-video/');
    assert.notEqual(a.cookie('sid'), aSid, 'the remember-me cookie started a new session');
    assert.equal(res.status, 200);
    assert.equal((await b.fetch('/upload-video/')).status, 302, 'which signed the other one out');

    // An old session rotates on a page view; the old id works for the grace period.
    clock.advance(3600_000);
    const before = a.cookie('sid');
    assert.equal((await a.fetch('/upload-video/')).status, 200);
    const after = a.cookie('sid');
    assert.notEqual(after, before);
    const stale = new CookieClient(base);
    stale.set('sid', before);
    assert.equal((await stale.fetch('/upload-video/')).status, 200, 'grace period');
    clock.advance(31_000);
    stale.set('sid', before);
    assert.equal((await stale.fetch('/upload-video/')).status, 302, 'then the old id is gone');

    // The scenario signs the account out at 7200 s; the remember-me cookie goes too.
    clock.set(EPOCH + 7_201_000);
    res = await a.fetch('/upload-video/');
    assert.equal(res.status, 302);
    assert.equal((await signIn(base, 'coach', 'pw').then(c => c.fetch('/upload-video/'))).status, 200, 'a password login works again');
});

test('a cache window serves someone else\'s page with age and a cache status', async (t) => {
    const { base, clock } = await start(t, { faults: [{ type: 'cacheWindow', at: 100, until: 200, path: '/upload-video/' }], signedOutUpload: 'login-form' });
    const a = await signIn(base);
    const guest = new CookieClient(base);
    let res = await guest.fetch('/upload-video/');
    assert.equal(res.status, 200, 'this site answers signed-out clients with the login form');
    assert.match(await res.text(), /name="pass"/);
    assert.equal(res.headers.get('x-cache-status'), null, 'no cache outside the window');

    clock.set(EPOCH + 110_000);
    res = await a.fetch('/upload-video/');
    assert.equal(res.headers.get('x-cache-status'), 'MISS');
    clock.set(EPOCH + 125_000);
    res = await guest.fetch('/upload-video/');
    const body = await res.text();
    assert.equal(res.headers.get('x-cache-status'), 'HIT');
    assert.equal(res.headers.get('age'), '15');
    assert.match(body, /name="content"/, 'a signed-in page for a signed-out client: only the headers tell');
    assert.equal(res.headers.get('set-cookie'), null);
});

test('chunked upload with retries; the video exists only after the metadata form; processing, slug URL and tiers', async (t) => {
    const { small, fullhd } = testClips();
    const { base, clock, sim, events } = await start(t, { faults: [{ type: 'chunkFault', at: 0, until: 50, mode: 'drop', index: 1 }] });
    const c = await signIn(base);
    // Inside the drop window index 1 never arrives; the client retries the same
    // index (and only it) once the window has passed.
    let up = await transfer(c, small, { onRetry: () => clock.set(EPOCH + 60_000) });
    assert.deepEqual(up.attempts.filter(a => !a.ok).map(a => a.index), [1]);
    assert.deepEqual(events('chunk').map(e => e.index), Array.from({ length: Math.ceil(small.length / 65536) }, (_, i) => i), 'each index stored once');

    // Nothing exists before the metadata form.
    let list = await (await c.fetch('/my/videos/')).text();
    assert.deepEqual(rows(list), []);
    assert.deepEqual(tabs(list), { public: 0, private: 0 });

    // Missing category, then a successful submit.
    let r = await submit(c, up, { title: 'Final at the Clay Court', categories: [] });
    assert.match(r.page, /Please choose at least one category/);
    r = await submit(c, up, { title: 'Final at the Clay Court' });
    assert.equal(r.status, 200);
    assert.match(r.page, /class="upload-success"/);
    assert.doesNotMatch(r.page, /data-item-id/, 'the success page does not show the id');
    const created = events('video-created')[0];
    const id = created.video;
    assert.match(id, /^\d+$/);
    assert.equal(created.sha256, sha(small));
    assert.deepEqual(created.tiers, [360]);
    assert.match((await submit(c, up, { title: 'Again' })).page, /already submitted/);

    // Processing: an empty href, edit page 404.
    list = await (await c.fetch('/my/videos/')).text();
    assert.deepEqual(rows(list), [{ id, cls: 'processing', href: '' }]);
    assert.equal((await c.fetch(`/edit-video/${id}/`)).status, 404, 'the false absence while processing');

    clock.set(EPOCH + 60_000 + 121_000);
    list = await (await c.fetch('/my/videos/')).text();
    const [row] = rows(list);
    assert.equal(row.href, `/video/${id}/final-at-the-clay-court/`);
    const edit = await (await c.fetch(`/edit-video/${id}/`)).text();
    assert.match(edit, new RegExp(`<a class="video-link" href="${base}/video/${id}/final-at-the-clay-court/"`));
    assert.match(edit, /id="edit_video_title" name="title" value="Final at the Clay Court"/);
    assert.match(edit, /name="category_ids\[\]" value="21"/);
    assert.equal((await fetch(`${base}/video/${id}/`)).status, 404, 'the slugless URL is a false 404');
    assert.equal((await fetch(`${base}/video/${id}/wrong-slug/`, { redirect: 'manual' })).headers.get('location'), `/video/${id}/final-at-the-clay-court/`);
    const pub = await (await fetch(`${base}/video/${id}/final-at-the-clay-court/`)).text();
    const vars = JSON.parse(/var flashvars = (\{.*\});/.exec(pub)[1]);
    assert.equal(vars.video_url_text, '360p');
    assert.equal(vars.video_alt_url, undefined, 'a 320x180 source gets the lowest tier only');
    let res = await fetch(vars.video_url, { headers: { range: 'bytes=0-99' } });
    assert.equal(res.status, 206);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(small.subarray(0, 100)));

    // A source 1920 wide gets the full-HD tier.
    up = await transfer(c, fullhd);
    await submit(c, up, { title: 'Wide angle' });
    const wide = events('video-created')[1];
    assert.deepEqual(wide.tiers, [1080, 720, 480, 360]);
    clock.advance(121_000);
    const widePage = await (await fetch(`${base}/video/${wide.video}/wide-angle/`)).text();
    const wideVars = JSON.parse(/var flashvars = (\{.*\});/.exec(widePage)[1]);
    assert.deepEqual(['video_url_text', 'video_alt_url_text', 'video_alt_url2_text', 'video_alt_url3_text'].map(k => wideVars[k]), ['360p', '480p', '720p HD', '1080p FHD']);
    res = await fetch(wideVars.video_alt_url3, { headers: { range: 'bytes=0-9' } });
    assert.equal(res.status, 206);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(fullhd.subarray(0, 10)), 'the 1080p tier of a 1920x1080 source is the upload itself');
    assert.equal(sim.sim.sites.get('form-host').describe(clock.now()).videos.length, 2);
});

test('quality tiers follow the source width', () => {
    const heights = f => qualityTiers(f).map(x => `${x.height}:${x.outWidth}x${x.outHeight}`);
    assert.deepEqual(heights({ width: 1920, height: 1080 }), ['1080:1920x1080', '720:1280x720', '480:854x480', '360:640x360']);
    assert.deepEqual(heights({ width: 1440, height: 1080 }), ['720:960x720', '480:640x480', '360:480x360'], 'no full HD below 1920 wide');
    assert.deepEqual(heights({ width: 1080, height: 1920 }), ['720:406x720', '480:270x480', '360:202x360'], 'portrait tops out at 406x720');
    assert.deepEqual(heights({ width: 320, height: 180 }), ['360:320x180']);
});

test('banned words, notices and limited visibility', async (t) => {
    const { small } = testClips();
    const { base, clock } = await start(t, {
        processingS: 0,
        bannedWords: [{ word: 'Brandname', action: 'refuse' }, { word: 'Sponsor', action: 'replace-notice', replacement: 'partner' }, { word: 'quiet', action: 'replace' }],
        visibilityRules: [{ word: 'walkover', reason: 'incomplete match' }],
    });
    const c = await signIn(base);
    let up = await transfer(c, small);
    let r = await submit(c, up, { title: 'Brandname cup final' });
    assert.match(r.page, /<div class="generic-error">Sorry, &#39;Brandname&#39; is not allowed here.<\/div>/);
    assert.deepEqual(rows(await (await c.fetch('/my/videos/')).text()), [], 'refused: nothing created');
    r = await submit(c, up, { title: 'Sponsor cup, a quiet walkover' });
    assert.match(r.page, /upload-success/);
    clock.advance(1000);
    const [row] = rows(await (await c.fetch('/my/videos/')).text());
    assert.equal(row.href, `/video/${row.id}/partner-cup-a-walkover/`, 'the stored title has the words replaced (and the slug follows)');
    const edit = await (await c.fetch(`/edit-video/${row.id}/`)).text();
    assert.match(edit, /value="partner cup, a \*\*\*\*\* walkover"/);
    assert.match(edit, /<div class="notice">Sorry, &#39;Sponsor&#39; is not allowed here.<\/div>/);
    assert.match(edit, /<div class="notice">Limited visibility due to : incomplete match<\/div>/);
    assert.doesNotMatch(edit, /&#39;quiet&#39;/, 'a silent replacement leaves no notice');
});

test('listing: tabs, lagging totals, pages, 404 past the end, transient 404s; removals', async (t) => {
    const { small } = testClips();
    const { base, clock, sim } = await start(t, {
        processingS: 0, pageSize: 2,
        removals: [{ nth: 1, at: 1000, reason: 'too short' }],
        faults: [{ type: 'listStatus', at: 900, until: 910, status: 404 }],
    });
    const c = await signIn(base);
    const ids = [];
    for (const [i, title] of ['First round', 'Second round', 'Quarter final', 'Private warmup'].entries()) {
        clock.set(EPOCH + 100_000 + i * 1000);
        await submit(c, await transfer(c, small), { title, private: title.startsWith('Private') });
        ids.push(sim.memory.records.filter(r => r.event === 'video-created').at(-1).video);
    }
    clock.set(EPOCH + 110_000);
    let page = await (await c.fetch('/my/videos/')).text();
    assert.deepEqual(tabs(page), { public: 3, private: 1 });
    assert.equal(heading(page), 0, 'the heading lags a minute behind');
    assert.deepEqual(rows(page).map(r => r.id), [ids[2], ids[1]], 'newest first, two a page');
    page = await (await c.fetch(block(2))).text();
    assert.deepEqual(rows(page).map(r => r.id), [ids[0]]);
    assert.ok(!page.includes('<html'), 'the async block alone');
    assert.equal((await c.fetch(block(3))).status, 404, 'past the end');
    page = await (await c.fetch(block(1) + '&is_private=1')).text();
    assert.deepEqual(rows(page).map(r => r.id), [ids[3]]);
    clock.set(EPOCH + 200_000);
    assert.equal(heading(await (await c.fetch('/my/videos/')).text()), 4);

    clock.set(EPOCH + 905_000);
    assert.equal((await c.fetch(block(1))).status, 404, 'a transient 404 on a page that exists');
    clock.set(EPOCH + 911_000);
    assert.equal((await c.fetch(block(1))).status, 200);

    // The first video is removed at 1000 s: edit page 404, row gone, tab totals lag.
    clock.set(EPOCH + 1_001_000);
    assert.equal((await c.fetch(`/edit-video/${ids[0]}/`)).status, 404);
    page = await (await c.fetch('/my/videos/')).text();
    assert.ok(!rows(page).some(r => r.id === ids[0]) && !rows(await (await c.fetch(block(2))).text()).some(r => r.id === ids[0]));
    assert.equal(tabs(page).public, 3, 'the tab still counts the removed video for a while');
    clock.set(EPOCH + 1_061_000);
    assert.equal(tabs(await (await c.fetch('/my/videos/')).text()).public, 2);

    // Removal through the control API.
    const res = await fetch(sim.urls.control + '/sites/form-host/remove', { method: 'POST', body: JSON.stringify({ id: ids[1] }) });
    assert.equal(res.status, 200);
    assert.equal((await c.fetch(`/edit-video/${ids[1]}/`)).status, 404);
});

test('failed processing (and a failure that recovers), unreadable uploads', async (t) => {
    const { small, junk } = testClips();
    const { base, clock } = await start(t, { processingS: 10, processingRules: [{ titleMatches: '^flaky', outcome: 'failed', recoverAfterS: 300 }] });
    const c = await signIn(base);
    await submit(c, await transfer(c, junk), { title: 'Not a video' });
    await submit(c, await transfer(c, small), { title: 'Flaky upload' });
    clock.advance(11_000);
    let list = rows(await (await c.fetch('/my/videos/')).text());
    assert.deepEqual(list.map(r => r.cls), ['error', 'error']);
    assert.deepEqual(list.map(r => r.href), [null, null], 'failed rows have no link');
    clock.advance(300_000);
    list = rows(await (await c.fetch('/my/videos/')).text());
    assert.deepEqual(list.map(r => r.cls), ['', 'error'], 'the flaky one published after all');
});

test('uploads, sessions and videos survive a restart with a state directory', async (t) => {
    const { small } = testClips();
    const stateDir = path.join(tempDir(t), 'state');
    const clock = new SimClock({ mode: 'manual', at: EPOCH + 10_000 });
    const first = await start(t, {}, { stateDir, clock });
    const c = await signIn(first.base);
    const up = await transfer(c, small);
    await first.close();

    const second = await start(t, {}, { stateDir, clock });
    const again = new CookieClient(second.base);
    again.jar = new Map(c.jar);
    assert.equal((await again.fetch('/upload-video/')).status, 200, 'still signed in');
    const r = await submit(again, up, { title: 'After the restart' });
    assert.match(r.page, /upload-success/, 'an upload finished before the restart can still be submitted');
    clock.advance(121_000);
    const [row] = rows(await (await again.fetch('/my/videos/')).text());
    assert.equal(row.href, `/video/${row.id}/after-the-restart/`);
    const file = await fetch(`${second.base}/get_file/${row.id}/360/${row.id}_360p.mp4/`);
    assert.equal(sha(Buffer.from(await file.arrayBuffer())), sha(small));
});
