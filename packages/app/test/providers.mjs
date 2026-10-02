import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webkit } from 'playwright-core';
import { testScrollSettlement } from './scroll-settlement.mjs';

// Isolated WebKit fixtures exercise the built frontend. Real iPhone HLS and
// trusted momentum are checked separately against the installed extension.
const extension = fs.readFileSync('dist/extension/xvideos/content.js', 'utf8');
const porntrexExtension = fs.readFileSync('dist/extension/porntrex/content.js', 'utf8');
const web = 'packages/app/build';
const listeners = [];
const background = { navigator: {userAgent:'Safari', platform:'MacIntel'}, console, setTimeout, clearTimeout,
    browser: {cookies: {getAllCookieStores:async()=>[], get:async()=>null,
        onChanged:{addListener:()=>listeners.push('cookies')}},
        runtime:{onInstalled:{addListener:()=>listeners.push('installed')},onStartup:{addListener:()=>listeners.push('startup')}},
        webRequest:{onCompleted:{addListener:()=>listeners.push('requests')}}}};
background.self = background;
vm.runInNewContext(extension, background);
assert.deepEqual(listeners, ['cookies','installed','startup','requests'], 'Cookie persistence must start in a worker without window/document');
const browser = await webkit.launch({ headless: true });
const options = { viewport: { width: 428, height: 800 }, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1' };

async function mediaFixture(context) {
    await context.addInitScript(() => {
        const time = new WeakMap(), paused = new WeakMap();
        Object.defineProperties(HTMLVideoElement.prototype, {
            videoWidth: { get: () => 428 }, videoHeight: { get: () => 600 }
        });
        Object.defineProperties(HTMLMediaElement.prototype, {
            readyState: { get: () => 4 }, duration: { get: () => 120 },
            currentTime: { get() { return time.get(this) ?? 0; }, set(value) { time.set(this, value); } },
            paused: { get() { return paused.get(this) ?? true; } },
            seekable: { get: () => ({ length: 1, start: () => 0, end: () => 120 }) }
        });
        HTMLMediaElement.prototype.load = function() {
            if (this.getAttribute('src')) queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')));
        };
        HTMLMediaElement.prototype.play = async function() { paused.set(this, false); };
        HTMLMediaElement.prototype.pause = function() { paused.set(this, true); };
    });
}

try {
    const context = await browser.newContext(options);
    await mediaFixture(context);
    const reads = [];
    let signedIn = true, laterFails = true, laterAttempts = 0;
    const name = n => n === 3 ? 'Full title [no timestamp]' : `2026-01-20 140639 Upload ${n}`;
    const upload = n => `<div id="listing-video-${n}"><p class="title"><a href="/video.fixture${n}/upload_${n}">${n === 3 ? name(n) : `Ignored title [${name(n)}]`}</a></p><p>Uploaded 5 days ago - Duration: ${n === 1 ? '16 min' : n === 2 ? '1 h 2 min 3 sec' : '02:30'}</p></div>`;
    await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        reads.push({ path: url.pathname, method: request.method(), host: url.hostname });
        assert.equal(request.method(), 'GET', 'Online provider must never mutate a PC or site');
        assert.ok(!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/hls/'));
        if (url.hostname === 'media.invalid') return route.fulfill({
            contentType: 'application/vnd.apple.mpegurl', headers: { 'Access-Control-Allow-Origin': '*' },
            body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1280x720\n720.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080\n1080.m3u8?signature=fixture'
        });
        if (/^\/account\/uploads(?:\/\d+)?$/.test(url.pathname)) {
            if (!signedIn) return route.fulfill({ contentType: 'text/html', body: '<input type="password">' });
            if (url.pathname.endsWith('/1')) {
                laterAttempts++;
                if (laterFails) return route.fulfill({ status: 503, body: 'Unavailable' });
            }
            return route.fulfill({ contentType: 'text/html', body: '<a href="/account/uploads/new">Upload</a>'
                + (url.pathname.endsWith('/1') ? upload(2) + upload(3)
                    : upload(1) + upload(2) + '<div class="pagination"><a href="/account/uploads/1">Next</a></div>') });
        }
        if (url.pathname.startsWith('/video.')) return route.fulfill({ contentType: 'text/html', body:
            `<script type="text/plain">html5player.setVideoHLS('https://media.invalid/${url.pathname.split('/')[1]}/hls_low.m3u8?signature=fixture')</script>` });
        return route.fulfill({ contentType: 'text/html', body: '<p id="native">Original</p>' });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const inject = () => page.addScriptTag({ content: extension });
    await page.goto('https://www.xvideos.com/account/uploads');
    await inject();
    await page.waitForSelector('a.video-row');
    assert.deepEqual(await page.locator('.video-name').allTextContents(), [name(1), name(2)]);
    assert.deepEqual(await page.locator('.video-meta > span:first-child').allTextContents(), ['16:00', '1:02:03']);
    assert.equal(await page.locator('.video-size').first().textContent(), '457.8 MiB', 'Size uses the requested medium 1080p bitrate estimate');
    await page.evaluate(() => { window.firstRow = document.querySelector('.video-row'); });
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('video-catalog:xvideos')).nextPage);
    assert.equal(reads.filter(read => read.path.startsWith('/video.')).length, 0, 'Listing does not resolve every source');
    await page.locator('a.video-row').first().click();
    await inject();
    await page.waitForSelector('.video-stage:not(.viewer-loading)');
    await page.waitForFunction(() => document.querySelector('.current-scope video').src.includes('1080.m3u8'));
    assert.equal(await page.locator('.streamer-name').textContent(), name(1));
    assert.equal(await page.locator('.progress-bar').count(), 1, 'Use the actual Video Platform overlay');
    assert.deepEqual(await page.locator('.buttons button:visible').allTextContents(), ['🔇']);
    assert.ok(reads.some(read => read.path.endsWith('/hls.m3u8')));
    assert.ok(!reads.some(read => read.path.endsWith('/hls_low.m3u8')));
    assert.equal(reads.filter(read => read.path === '/account/uploads').length, 2, 'No extra catalog authentication request in viewer');
    laterFails = false;
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('video-catalog:xvideos')).videos.length === 3);
    const state = await page.evaluate(() => sessionStorage.getItem('video-catalog:xvideos'));
    assert.ok(!state.includes('media.invalid') && !state.includes('signature'), 'Never persist signed sources');
    await testScrollSettlement(page, 'xvideos', '');
    // Return to the first entry before checking saved progress and Back.
    await page.evaluate(() => history.replaceState(null, '', '/video.fixture1/upload_1'));
    await page.reload(); await inject();
    await page.waitForSelector('.video-stage:not(.viewer-loading)');
    await page.evaluate(() => {
        document.querySelector('.current-scope video').currentTime = 42;
        dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });
    assert.equal(await page.evaluate(() => localStorage.getItem('video-progress-1')), '42');
    await page.goBack(); await inject();
    await page.waitForFunction(() => document.querySelectorAll('.video-row').length === 3);
    assert.equal(await page.locator('.current-video').count(), 1);
    assert.equal(await page.locator('.current-video .video-name').textContent(), name(1));
    await page.reload(); await inject();
    await page.waitForFunction(() => document.querySelectorAll('.video-row').length === 3);
    assert.deepEqual(await page.locator('.video-name').allTextContents(), [name(1), name(2), name(3)]);
    assert.ok(laterAttempts >= 2, 'Failed pagination recovers');
    assert.deepEqual(errors, []);
    await page.goto('https://www.xvideos.com/account/uploads/new'); await inject();
    assert.equal(await page.locator('#native').count(), 1, 'Upload management stays native');
    signedIn = false;
    await page.goto('https://www.xvideos.com/account/uploads'); await inject();
    await page.waitForURL('**/account');
    signedIn = true;
    await page.close();
    await context.addInitScript({ content: extension });
    const early = await context.newPage();
    await early.goto('https://www.xvideos.com/account/uploads', { waitUntil: 'commit' });
    await early.waitForSelector('a.video-row');
    assert.equal(await early.evaluate(() => !!document.head && !!document.body && !!window.__videoPlatformExtensionBoot.readyAt), true,
        'Safari document-start takeover creates its own head/body before the site parser does');
    assert.equal(await early.evaluate(() => window.__videoPlatformExtensionBoot.entries), 1);
    console.log('PASS: shared online UI, highest quality, incremental/recovering pagination, progress, Back/reload, no PC calls, native login/management.');
    await context.close();

    const ptrex = await browser.newContext(options);
    await mediaFixture(ptrex);
    const ptReads = [];
    let ptSignedIn = true;
    const ptName = n => n === 3 ? 'Full title 2026-07-13 162147 no brackets' : `2026-01-20 14063${n} Upload ${n}`;
    const ptRow = n => `<div class="video-item" data-item-id="${n}"><a class="thumb" href="https://www.porntrex.com/video/${n}/upload-${n}/"></a>`
        + `<div class="durations"><i class="fa fa-clock-o"></i> ${['61:22', '1:02:03', '2:30'][n - 1]}</div>`
        + `<p class="inf"><a href="https://www.porntrex.com/video/${n}/upload-${n}/">${n === 3 ? ptName(n) : `Ignored title [${ptName(n)}]`}</a></p></div>`;
    await ptrex.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        ptReads.push(url.pathname);
        assert.equal(request.method(), 'GET', 'Online provider must never mutate a PC or site');
        assert.ok(!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/hls/'));
        if (url.pathname === '/my/videos/') {
            // Real signed-out requests redirect to the home page; Playwright cannot fake that redirect.
            if (!ptSignedIn) return route.fulfill({ contentType: 'text/html', body: '<form><input name="username"><input type="password"></form>' });
            return route.fulfill({ contentType: 'text/html', body: '<div id="list_videos_my_uploaded_videos"><h2>My Videos (3)</h2>'
                + ptRow(1) + ptRow(2) + ptRow(3) + '</div>' });
        }
        if (/^\/video\/\d+\/[^/]+\/$/.test(url.pathname)) {
            const id = url.pathname.split('/')[2], file = q => `https://www.porntrex.com/get_file/8/fixture${id}/${q}.mp4/`;
            return route.fulfill({ contentType: 'text/html', body: `<script>var flashvars = { video_id: '${id}', `
                + `video_url: '${file('480p')}', video_url_text: '480p', video_alt_url: '${file('720p')}', video_alt_url_text: '720p HD', `
                + `video_alt_url2: '${file('2160p')}', video_alt_url2_text: '2160p 4K', video_alt_url3: '${file('1080p')}', video_alt_url3_text: '1080p FHD' };</script>` });
        }
        if (url.pathname.startsWith('/get_file/')) return route.fulfill({ contentType: 'video/mp4', body: '' });
        return route.fulfill({ contentType: 'text/html', body: '<p id="native">Original</p><form><input type="password"></form>' });
    });
    const pt = await ptrex.newPage();
    const ptErrors = [];
    pt.on('pageerror', error => ptErrors.push(error.message));
    const ptInject = () => pt.addScriptTag({ content: porntrexExtension });
    await pt.goto('https://www.porntrex.com/my/videos/');
    await ptInject();
    await pt.waitForSelector('a.video-row');
    assert.deepEqual(await pt.locator('.video-name').allTextContents(), [ptName(1), ptName(2), ptName(3)],
        'Bracketed timestamps become the label; unbracketed titles stay whole');
    assert.deepEqual(await pt.locator('.video-meta > span:first-child').allTextContents(), ['1:01:22', '1:02:03', '02:30']);
    assert.equal(ptReads.filter(path => path.startsWith('/video/')).length, 0, 'Listing does not resolve every source');
    await pt.locator('a.video-row').first().click();
    await pt.waitForURL('**/video/1/upload-1/');
    await ptInject();
    await pt.waitForSelector('.video-stage:not(.viewer-loading)');
    await pt.waitForFunction(() => document.querySelector('.current-scope video').src.endsWith('/fixture1/2160p.mp4/'));
    assert.equal(await pt.locator('.streamer-name').textContent(), ptName(1));
    assert.deepEqual(await pt.locator('.buttons button:visible').allTextContents(), ['🔇']);
    const ptState = await pt.evaluate(() => sessionStorage.getItem('video-catalog:porntrex'));
    assert.ok(!ptState.includes('get_file') && !JSON.parse(ptState).nextPage, 'Never persist sources; one uploads page');
    await testScrollSettlement(pt, 'porntrex', '');
    await pt.goBack(); await ptInject();
    await pt.waitForFunction(() => document.querySelectorAll('.video-row').length === 3);
    assert.equal(await pt.locator('.current-video').count(), 1);
    assert.deepEqual(ptErrors, []);
    ptSignedIn = false;
    await pt.goto('https://www.porntrex.com/my/videos/'); await ptInject();
    await pt.waitForURL('**/login/');
    await ptInject();
    assert.equal(await pt.locator('#native').count(), 1, 'Login stays native');
    ptSignedIn = true;
    await pt.waitForURL('**/my/videos/', { timeout: 10_000 });
    await pt.close();
    await ptrex.addInitScript({ content: porntrexExtension });
    const ptEarly = await ptrex.newPage();
    await ptEarly.goto('https://www.porntrex.com/my/videos/', { waitUntil: 'commit' });
    await ptEarly.waitForSelector('a.video-row');
    assert.equal(await ptEarly.evaluate(() => window.__videoPlatformExtensionBoot.entries), 1);
    console.log('PASS: Porntrex uploads, timestamp labels, durations, highest MP4 quality, Back, signed-out redirect to native login, document-start takeover.');
    await ptrex.close();

    // Tango live: the gateway answers tango.me with credentialed CORS, like the real site.
    const tango = await browser.newContext(options);
    await mediaFixture(tango);
    await tango.addInitScript(() => {
        localStorage.setItem('latest_account_id', 'me'); sessionStorage.setItem('username', 'session-1');
        // Fixture media cannot really play: media error listeners hear only the deliberately ended
        // stream's (untrusted) error. Prototype patches survive the takeover's document.open().
        const add = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function(type, listener, options) {
            if (type === 'error' && this instanceof HTMLMediaElement && typeof listener === 'function') {
                const original = listener;
                listener = function(event) { if (!event.isTrusted) return original.call(this, event); };
            }
            return add.call(this, type, listener, options);
        };
        const load = HTMLMediaElement.prototype.load;
        HTMLMediaElement.prototype.load = function() {
            if ((this.getAttribute('src') ?? '').includes('ended')) queueMicrotask(() => this.dispatchEvent(new Event('error')));
            else load.call(this);
        };
    });
    const calls = [];
    let downloads = ['B'];
    const record = (id, following, ended = false) => ({ isPublic: true, anchor: { encryptedAccountId: id, firstName: `First ${id}`, aliases: [{ alias: `alias${id}` }] },
        stream: { id: `s${id}`, status: 'LIVING', masterListUrl: `https://media.invalid/${ended ? 'ended-' : ''}${id}.m3u8` } });
    const cors = { 'Access-Control-Allow-Origin': 'https://tango.me', 'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Headers': 'Content-Type, Accept', 'Access-Control-Allow-Methods': 'GET, POST' };
    await tango.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.hostname === 'tango.me') return route.fulfill({ contentType: 'text/html', body: '<p id="native">Tango</p>' });
        if (url.hostname === 'media.invalid') return route.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n' });
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'Access-Control-Allow-Origin': request.headers().origin } });
        const body = request.postData() ?? '';
        if (url.hostname === '192.168.1.197') {
            const pc = { 'Access-Control-Allow-Origin': '*' };
            calls.push(`pc ${url.pathname} ${body}`);
            if (url.pathname === '/api/tango/list') return route.fulfill({ headers: pc, json: downloads });
            const { identifier } = JSON.parse(body);
            downloads = url.pathname.endsWith('/add') ? [...downloads, identifier] : downloads.filter(id => id !== identifier);
            return route.fulfill({ headers: pc, json: { success: true } });
        }
        assert.equal(url.hostname, 'gateway.tango.me');
        calls.push(`${request.method()} ${url.pathname} ${body}`);
        const json = json => route.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify(json) });
        if (url.pathname.endsWith('/session/web/refresh') || url.pathname.endsWith('/tokenData')) return json({});
        if (url.pathname === '/abregistrar/connection/v1/blocklist') return json(request.method() === 'POST' ? { error_code: 0 } : { users: ['D'] });
        if (url.pathname.endsWith('/list/following')) return json({ records: [record('A', true), record('B', true)] });
        if (url.pathname.endsWith('/following_recommendations')) return json({ records: [record('B', false), record('C', false, true), record('D', false)] });
        if (url.pathname.endsWith('/profiles/v2/batch')) return json(Object.fromEntries(JSON.parse(body).map(id => [id, { basicProfile: { firstName: `First ${id}`, aliases: [{ alias: `alias${id}` }] } }])));
        if (url.pathname.endsWith('/live/stream/v2/watch')) return json(body === 'sA' ? { multiBroadcast: { streams: ['A', 'E', 'C'].map(id =>
            ({ stream: { mbDescriptor: { accountId: id, streamId: `s${id}` }, streamURL: `https://media.invalid/${id === 'C' ? 'ended-' : ''}${id}.m3u8` } })) } } : {});
        if (url.pathname.includes('/follow/')) return json({});
        throw new Error('Unexpected Tango request ' + url.pathname);
    });
    const tg = await tango.newPage();
    const tgErrors = [];
    tg.on('pageerror', error => tgErrors.push(error.message));
    const tgInject = () => tg.addScriptTag({ content: fs.readFileSync('dist/extension/tango-live/content.js', 'utf8') });
    const catalog = () => tg.evaluate(() => JSON.parse(sessionStorage.getItem('video-catalog:tango-live')).videos.map(video => video.filename));
    await tg.goto('https://tango.me/'); await tgInject();
    await tg.waitForSelector('a.video-row');
    assert.ok(calls.some(call => call.includes('/session/web/refresh') && call.includes('"accountId":"me"') && call.includes('"sessionId":"session-1"')),
        'The session refresh names the account and session the app supplied');
    assert.deepEqual(await tg.locator('.video-name').allTextContents(), ['aliasA First A', 'aliasB First B', 'aliasC First C'],
        'Followed first, one entry per streamer, blocked streamers hidden');
    assert.deepEqual(await tg.locator('.video-meta > span:first-child').allTextContents(), ['LIVE', 'LIVE', 'LIVE']);
    await tg.locator('a.video-row').first().click();
    await tg.waitForURL('**/stream/sA'); await tgInject();
    await tg.waitForFunction(() => document.querySelector('.current-scope video')?.src.endsWith('/A.m3u8'));
    await tg.waitForFunction(() => document.querySelector('.buttons button[title="Follow or unfollow"]')?.textContent === '❤️');
    assert.ok(await tg.locator('.progress-bar').isHidden(), 'Live streams have no timeline');
    await tg.waitForFunction(() => [...document.querySelectorAll('.buttons button')].some(b => !b.hidden && b.textContent === '➕'));
    await tg.waitForFunction(() => JSON.parse(sessionStorage.getItem('video-catalog:tango-live')).videos.length === 4);
    assert.deepEqual(await catalog(), ['A', 'B', 'C', 'E'], 'A new co-streamer joins at the bottom; existing ones keep their place');
    await tg.locator('.buttons button[title="Follow or unfollow"]').click();
    await tg.waitForFunction(() => document.querySelector('.buttons button[title="Follow or unfollow"]').textContent === '🤍');
    assert.ok(calls.includes('POST /proxycador/api/public/v1/follow/remove A'));
    await tg.locator('.buttons button', { hasText: '➕' }).click();
    await tg.waitForFunction(() => [...document.querySelectorAll('.buttons button')].some(b => !b.hidden && b.textContent === '➖'));
    assert.ok(calls.includes('pc /api/tango/add {"identifier":"A"}'), 'The +/- button edits the PC Tango list by streamer');
    await tg.locator('.buttons button[title="Block"]').click();
    assert.equal(await tg.locator('.buttons button[title="Tap again to block"]').textContent(), '❓');
    await tg.locator('.buttons button[title="Tap again to block"]').click();
    await tg.waitForFunction(() => document.querySelector('.current-scope video')?.src.endsWith('/B.m3u8'));
    assert.ok(calls.includes('POST /abregistrar/connection/v1/blocklist {"action":"BLOCK","account_id":["A"]}'));
    assert.deepEqual(await catalog(), ['B', 'C', 'E'], 'A blocked streamer leaves; the next stream takes its place');
    await tg.goto('https://tango.me/stream/sC'); await tgInject();
    await tg.waitForFunction(() => document.querySelector('.current-scope video')?.src.endsWith('/E.m3u8'));
    assert.deepEqual(await catalog(), ['B', 'E'], 'An ended stream leaves; the next one takes its place');
    assert.ok(!calls.some(call => call.startsWith('pc ') && !call.includes('/api/tango/')), 'Only the Tango download list is used');
    assert.deepEqual(tgErrors, []);
    await tango.addInitScript({ content: fs.readFileSync('dist/extension/tango-live/content.js', 'utf8') });
    const tgEarly = await tango.newPage();
    await tgEarly.goto('https://tango.me/', { waitUntil: 'commit' });
    await tgEarly.waitForSelector('a.video-row');
    assert.equal(await tgEarly.evaluate(() => window.__videoPlatformExtensionBoot.entries), 1);
    console.log('PASS: Tango live list, Follow, +/- download list, two-step Block, co-streamers at the bottom, ended streams replaced by the next, document-start takeover.');
    await tango.close();

    const local = await browser.newContext(options);
    await mediaFixture(local);
    const writes = [];
    await local.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() !== 'GET') { writes.push(url.pathname); return route.abort(); }
        if (url.pathname === '/api/videos') return route.fulfill({ json: [1,2,3].map(n => ({ filename: `fixture-${n}`, type: 'original', duration: 120, size: 0, isLive: false })) });
        if (/^\/api\/(tango|fc2|sc)\/list$/.test(url.pathname)) return route.fulfill({ json: [] });
        if (url.pathname.startsWith('/hls/')) return route.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXTINF:120,\nfixture.ts\n#EXT-X-ENDLIST\n' });
        const file = path.join(web, url.pathname.startsWith('/assets/') ? url.pathname : 'index.html');
        return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    const localPage = await local.newPage();
    for (const provider of ['tango', 'fc2', 'sc']) {
        await localPage.goto(`https://local.invalid/videos/${provider}`);
        await localPage.locator('a.video-row').first().click();
        await localPage.waitForSelector('.video-stage:not(.viewer-loading)');
        await localPage.waitForSelector('.list-add:not(:disabled)');
        assert.ok(await localPage.locator('.buttons button').filter({ hasText: '📍' }).isVisible());
        assert.match(await localPage.locator('.current-scope video').getAttribute('src'), new RegExp(`/hls/${provider}/fixture-1/playlist.m3u8`));
    }
    await localPage.goto('https://local.invalid/videos/tango/fixture-1?type=original');
    await localPage.waitForSelector('.video-stage:not(.viewer-loading)');
    await testScrollSettlement(localPage);
    assert.deepEqual(writes, [], 'Fixtures never mutate real libraries');
    console.log('PASS: all three local providers retain playback/editing controls and shared scrolling.');
    await local.close();
} finally { await browser.close(); }
