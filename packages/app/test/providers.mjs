import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { webkit } from 'playwright-core';
import { testScrollSettlement } from './scroll-settlement.mjs';

// Isolated WebKit fixtures exercise the built frontend and the apps' content scripts.
// Real iPhone HLS and trusted momentum are checked separately in the installed apps.
const web = 'packages/app/build';
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
    // Video Vault (formerly Ptrex) lives on porntrex.com and reads XVideos pages through the app
    // (VideoApp/SiteWorker.swift); `vaultRead` stands in for its hidden xvideos.com page.
    const vaultContext = await browser.newContext(options);
    await mediaFixture(vaultContext);
    const vaultReads = [], bridgeReads = [];
    let xvSignedIn = true, ptSignedIn = true, stall = null;
    const xvRow = (n, title, length) => `<div id="listing-video-${n}"><p class="title"><a href="https://ads.invalid/${n}">Ad</a>`
        + `<a href="/video.fixture${n}/upload_${n}">${title}</a></p><p>Uploaded 5 days ago - Duration: ${length}</p></div>`;
    const ptRow = (n, title, length) => `<div class="video-item" data-item-id="${n}"><a class="thumb" href="https://www.porntrex.com/video/${n}/upload-${n}/"></a>`
        + `<div class="durations"><i class="fa fa-clock-o"></i> ${length}</div><p class="inf"><a href="https://www.porntrex.com/video/${n}/upload-${n}/">${title}</a></p></div>`;
    // The real list shows 30 per page; page 2 is reachable only through its AJAX link.
    const ptPager = '<div class="pagination"><ul><li class="page"><a aria-label="pagination" href="#videos" data-action="ajax" data-parameters="sort_by:;from_my_videos:02">02</a></li></ul></div>';
    // XVideos as its own pages answer, for the bridge (and for the login page itself).
    const xvideosPage = pathname => {
        if (/^\/account\/uploads(?:\/\d+)?$/.test(pathname)) {
            if (!xvSignedIn) return { body: '<input type="password">' };
            return { body: '<a href="/account/uploads/new">Upload</a>' + (pathname.endsWith('/1')
                ? xvRow(3, '2023-10-04 155600 [68190398] asahi', '02:30') + xvRow(4, 'Full title [no timestamp]', '10 min')
                : xvRow(1, 'Ignored title [2026-01-20 140639 alice]', '16 min') + xvRow(2, 'Rotated [2025-11-05 010222 bob | rotation-flag-left]', '1 h 2 min 3 sec')
                    + '<div class="pagination"><a href="https://ads.invalid/next">Ad</a><a href="/account/uploads/1">Next</a></div>') };
        }
        if (pathname.startsWith('/video.')) return { body:
            `<script type="text/plain">html5player.setVideoHLS('https://media.invalid/${pathname.split('/')[1]}/hls_low.m3u8?signature=fixture')</script>`
            + '<div class="video-metadata video-tags-list"><ul><li><a class="is-keyword" href="/tags/live">live</a></li><li><a class="is-keyword" href="/tags/stripchat">stripchat</a></li></ul></div>' };
        return { body: '<p id="native">XVideos</p><form><input type="password"></form>' };
    };
    await vaultContext.exposeFunction('vaultRead', async (site, path) => {
        assert.equal(site, 'xvideos');
        assert.ok(path.startsWith('/') && !path.startsWith('//'));
        bridgeReads.push(path);
        await stall;
        const url = new URL(path, 'https://www.xvideos.com');
        return { status: 200, url: url.href, text: xvideosPage(url.pathname).body };
    });
    await vaultContext.addInitScript(() => {
        const lists = { tango: ['other'], fc2: [], sc: [] };
        // Which providers have a streamer by the name (the server asks them), and whether asking fails.
        window.existsOn = { sc: true };
        window.listCalls = [];
        window.webkit = { messageHandlers: {
            vaultSite: { postMessage: message => window.vaultRead(message.site, message.path) },
            downloadList: { postMessage: async message => {
                window.listCalls.push([message.action, message.list, message.identifier].filter(Boolean).join(' '));
                if (window.pcDown) throw new Error('Could not connect to the server.');
                if (message.action === 'exists') return window.lookupFails
                    ? { status: 502, body: JSON.stringify({ error: 'Tango authentication is unavailable' }) }
                    : { status: 200, body: JSON.stringify({ exists: Boolean(window.existsOn[message.list]) }) };
                const list = lists[message.list];
                if (message.action === 'add') list.push(message.identifier);
                if (message.action === 'remove') list.splice(list.indexOf(message.identifier), 1);
                return { status: 200, body: JSON.stringify(message.action === 'member' ? { member: list.includes(message.identifier) } : { success: true }) };
            } },
        } };
    });
    await vaultContext.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        vaultReads.push({ host: url.hostname, path: url.pathname, navigation: request.isNavigationRequest() });
        assert.equal(request.method(), 'GET', 'Online provider must never mutate a PC or site');
        if (url.hostname === 'media.invalid') return route.fulfill({
            contentType: 'application/vnd.apple.mpegurl', headers: { 'Access-Control-Allow-Origin': '*' },
            body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1280x720\n720.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080\n1080.m3u8?signature=fixture'
        });
        if (url.hostname === 'www.xvideos.com') return route.fulfill({ contentType: 'text/html', body: xvideosPage(url.pathname).body });
        assert.equal(url.hostname, 'www.porntrex.com');
        // Any unknown Porntrex path is its 404 page, which the vault takes over.
        if (url.pathname.startsWith('/video-vault/')) return route.fulfill({ status: 404, contentType: 'text/html', body: '<p>404</p>' });
        if (url.pathname === '/my/videos/') {
            await stall;
            // Real signed-out requests redirect to the home page; Playwright cannot fake that redirect.
            if (!ptSignedIn) return route.fulfill({ contentType: 'text/html', body: '<form><input name="username"><input type="password"></form>' });
            if (url.searchParams.get('from_my_videos') === '2') return route.fulfill({ contentType: 'text/html',
                body: '<div id="list_videos_my_uploaded_videos">' + ptRow(3, 'String panty 2026-07-13 162147 AI_channel', '4:42') + '</div>' });
            return route.fulfill({ contentType: 'text/html', body: '<div id="list_videos_my_uploaded_videos">'
                + ptRow(1, 'Ignored title [2026-01-20 140639 alice]', '61:22') + ptRow(2, 'Bikinis [2026-01-21 235709 dilaras7]', '1:02:03') + '</div>' + ptPager });
        }
        if (/^\/video\/\d+\/[^/]+\/$/.test(url.pathname)) {
            const id = url.pathname.split('/')[2], file = q => `https://www.porntrex.com/get_file/8/fixture${id}/${q}.mp4/`;
            return route.fulfill({ contentType: 'text/html', body: `<script>var flashvars = { video_id: '${id}', `
                + `video_url: '${file('480p')}', video_url_text: '480p', video_alt_url2: '${file('2160p')}', video_alt_url2_text: '2160p 4K', `
                + `video_alt_url3: '${file('1080p')}', video_alt_url3_text: '1080p FHD', video_tags: 'Tango, live, Upload' };</script>` });
        }
        if (url.pathname.startsWith('/get_file/')) return route.fulfill({ contentType: 'video/mp4', body: '' });
        return route.fulfill({ contentType: 'text/html', body: '<p id="native">Porntrex</p>' });
    });
    const vaultScript = fs.readFileSync('dist/content/vault/content.js', 'utf8');
    const vp = await vaultContext.newPage();
    const vaultErrors = [];
    vp.on('pageerror', error => vaultErrors.push(error.message));
    const vInject = () => vp.addScriptTag({ content: vaultScript });
    const names = () => vp.locator('.video-name').allTextContents();
    // A reload that opened with the kept list is still running while `restart` is set.
    const reloaded = () => vp.waitForFunction(() => {
        const catalog = JSON.parse(sessionStorage.getItem('video-catalog:vault'));
        return catalog && !catalog.nextPage && !catalog.restart;
    });
    const marks = () => vp.locator('.video-mark').allTextContents();
    // Only the pipeline's uploads: the 2023 manual upload, the bare-stamp title (an upload taken
    // out of the archive) and the title without a recording are on the sites but not listed.
    const order = ['2025-11-05 010222 bob | rotation-flag-left', '2026-01-20 140639 alice',
        '2026-01-20 140639 alice', '2026-01-21 235709 dilaras7'];
    await vp.goto('https://www.porntrex.com/video-vault/'); await vInject();
    await reloaded();
    await vp.waitForFunction(() => document.querySelectorAll('a.video-row').length === 4);
    assert.deepEqual(await names(), order, "Both sites' pipeline uploads (a bracketed recording), oldest recording first");
    assert.deepEqual(await marks(), ['', 'Xvid', 'Ptrex', ''], 'Only the recording on both sites says which site each row is');
    assert.deepEqual(await vp.locator('.video-meta > span:first-child').allTextContents(), ['1:02:03', '16:00', '1:01:22', '1:02:03']);
    assert.deepEqual(bridgeReads, ['/account/uploads', '/account/uploads/1'], 'XVideos pages come through the app');
    assert.ok(!vaultReads.some(read => read.host === 'www.xvideos.com'), 'The vault page never asks XVideos itself');
    assert.equal(await vp.locator('.video-notice').count(), 0);
    const complete = await vp.evaluate(() => localStorage.getItem('video-catalog:vault:complete'));
    assert.equal(JSON.parse(complete).videos.length, 4, 'The complete list is kept to open with');
    assert.ok(!complete.includes('media.invalid') && !complete.includes('get_file'), 'Never persist signed sources');
    await vp.locator('a.video-row', { hasText: 'alice' }).first().click();
    await vp.waitForURL('**/video-vault/xvideos/video.fixture1/upload_1'); await vInject();
    await vp.waitForSelector('.video-stage:not(.viewer-loading)');
    await vp.waitForFunction(() => document.querySelector('.current-scope video').src.includes('1080.m3u8'));
    assert.equal(await vp.locator('.streamer-name').textContent(), '2026-01-20 140639 alice');
    await vp.waitForFunction(() => document.querySelector('.next-scope video').src.endsWith('/fixture1/2160p.mp4/'), null, { timeout: 5000 });
    await vp.waitForFunction(() => document.querySelector('.previous-scope video').src.includes('/video.fixture2/'));
    // The +/- button: the streamer is in none of the three lists. Adding asks the three providers
    // at once who has the name: only Stripchat does, so it goes straight to the SC list.
    const member = ['member tango alice', 'member fc2 alice', 'member sc alice'];
    const exists = ['exists tango alice', 'exists fc2 alice', 'exists sc alice'];
    await vp.locator('.list-add:not(:disabled)').click();
    await vp.waitForSelector('.list-remove:not(:disabled)');
    assert.deepEqual(await vp.evaluate(() => window.listCalls), [...member, ...exists, 'add sc alice', ...member], 'One hit adds without asking');
    await vp.locator('.list-remove').click();
    await vp.waitForSelector('.list-add:not(:disabled)');
    // Two providers have the name: only they are offered.
    await vp.evaluate(() => { window.existsOn = { tango: true, sc: true }; });
    await vp.locator('.list-add').click();
    await vp.waitForSelector('.list-choice');
    assert.deepEqual(await vp.locator('.buttons button:visible').allTextContents(), ['🔇', 'Tango', 'SC'], 'Several hits ask which provider');
    await vp.locator('.list-choice', { hasText: 'SC' }).click();
    await vp.waitForSelector('.list-remove:not(:disabled)');
    // Removing from the one list that has the streamer needs no choice; a failed change keeps ➖, ringed.
    await vp.evaluate(() => { window.pcDown = true; });
    await vp.locator('.list-remove').click();
    await vp.waitForSelector('.list-remove.list-error:not(:disabled)');
    assert.equal(await vp.locator('.list-remove').getAttribute('title'), 'Could not connect to the server.');
    // Swipe down to the Porntrex upload of the same recording.
    await vp.evaluate(() => {
        const stage = document.querySelector('.video-stage');
        for (const video of stage.querySelectorAll('video')) video.style.height = '600px';
        window.fixtureTouch = type => {
            const point = { identifier: 1, target: stage, clientX: 200, clientY: type === 'touchstart' ? 400 : 350 };
            const event = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperties(event, { touches: { value: type === 'touchend' ? [] : [point] }, changedTouches: { value: [point] } });
            stage.dispatchEvent(event);
        };
        window.fixtureTouch('touchstart'); window.fixtureTouch('touchmove');
        const next = stage.querySelector('.next-scope video').getBoundingClientRect();
        window.scrollTo(0, window.scrollY + next.top + next.height / 2 - innerHeight / 2);
        window.dispatchEvent(new Event('scroll'));
    });
    await vp.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await vp.evaluate(() => { window.fixtureTouch('touchend'); window.dispatchEvent(new Event('scrollend')); });
    await vp.waitForURL('**/video-vault/porntrex/video/1/upload-1/');
    assert.equal(await vp.evaluate(() => localStorage.getItem('video-highlight:vault')), 'porntrex-1', 'Equal site IDs stay distinct');
    await vp.waitForSelector('button.list-error:disabled');
    assert.equal(await vp.locator('button.list-error').textContent(), '⚠️', 'As in Tango, an unreachable PC shows ⚠️');
    await vp.evaluate(() => { window.pcDown = false; });
    // A restored app opens a viewer from its URL alone: the kept list, or else the route itself.
    await vp.evaluate(() => sessionStorage.clear()); await vp.reload(); await vInject();
    await vp.waitForFunction(() => document.querySelector('.current-scope video')?.src.endsWith('/fixture1/2160p.mp4/'));
    await vp.evaluate(() => { sessionStorage.clear(); localStorage.removeItem('video-catalog:vault:complete'); }); await vp.reload(); await vInject();
    await vp.waitForFunction(() => document.querySelector('.current-scope video')?.src.endsWith('/fixture1/2160p.mp4/'));
    await vp.waitForFunction(() => document.querySelector('.previous-scope video')?.src.includes('/video.fixture1/'), null, { timeout: 5000 });
    await vp.goBack(); await vInject();
    await vp.waitForFunction(() => document.querySelectorAll('.video-row').length === 4);
    assert.equal(await vp.locator('.current-video .video-mark').textContent(), 'Ptrex');
    // The kept list opens at once while both sites reload.
    let release;
    stall = new Promise(resolve => { release = resolve; });
    await vp.goto('https://www.porntrex.com/video-vault/'); await vInject();
    await vp.waitForFunction(() => document.querySelectorAll('a.video-row').length === 4);
    assert.deepEqual(await names(), order);
    release(); stall = null;
    await reloaded();
    // A signed-out site keeps its rows and says how to sign it back in.
    xvSignedIn = false;
    await vp.goto('https://www.porntrex.com/video-vault/'); await vInject();
    await vp.waitForSelector('a.video-notice');
    await reloaded();
    assert.deepEqual(await names(), order, 'Its earlier rows stay');
    assert.equal(await vp.locator('a.video-notice').getAttribute('href'), 'https://www.xvideos.com/account');
    await vp.locator('a.video-notice').click();
    await vp.waitForURL('https://www.xvideos.com/account'); await vInject();
    assert.equal(await vp.locator('#native').count(), 1, 'XVideos login stays native');
    xvSignedIn = true;
    await vp.waitForURL('https://www.porntrex.com/video-vault/', { timeout: 10_000 }); await vInject();
    await vp.waitForFunction(() => document.querySelectorAll('a.video-row').length === 4);
    await reloaded();
    assert.equal(await vp.locator('.video-notice').count(), 0, 'Signed back in, the notice goes');
    ptSignedIn = false;
    await vp.goto('https://www.porntrex.com/video-vault/'); await vInject();
    await vp.waitForSelector('p.video-notice');
    assert.match(await vp.locator('p.video-notice').textContent(), /ptrex:connect-iphone/, 'Porntrex is never logged into on the phone');
    await reloaded();
    assert.deepEqual(await names(), order);
    ptSignedIn = true;
    assert.deepEqual(vaultErrors, []);
    await vp.close();
    // Ptrex's own pages (a restored Ptrex tab) open in the vault; it takes over at document start.
    await vaultContext.addInitScript({ content: vaultScript });
    const vaultEarly = await vaultContext.newPage();
    vaultEarly.on('pageerror', error => vaultErrors.push(error.message));
    await vaultEarly.goto('https://www.porntrex.com/my/videos/', { waitUntil: 'commit' });
    await vaultEarly.waitForURL('https://www.porntrex.com/video-vault/');
    await vaultEarly.waitForSelector('a.video-row');
    assert.equal(await vaultEarly.evaluate(() => window.__videoPlatformBoot.entries), 1);
    await vaultEarly.goto('https://www.porntrex.com/video/2/upload-2/', { waitUntil: 'commit' });
    await vaultEarly.waitForURL('**/video-vault/porntrex/video/2/upload-2/');
    await vaultEarly.waitForFunction(() => document.querySelector('.current-scope video')?.src.endsWith('/fixture2/2160p.mp4/'));
    // No provider has the name: 🔍. A provider that cannot answer: ⚠️, never a miss.
    const lookup = await vaultContext.newPage();
    lookup.on('pageerror', error => vaultErrors.push(error.message));
    const lookupOpen = async () => {
        await lookup.goto('https://www.porntrex.com/video-vault/porntrex/video/2/upload-2/');
        await lookup.addScriptTag({ content: vaultScript });
        await lookup.waitForSelector('.list-add:not(:disabled)');
    };
    await lookupOpen();
    await lookup.evaluate(() => { window.existsOn = {}; });
    await lookup.locator('.list-add').click();
    await lookup.waitForSelector('.buttons button:disabled:text-is("🔍")');
    await lookupOpen();
    await lookup.evaluate(() => { window.lookupFails = true; });
    await lookup.locator('.list-add').click();
    await lookup.waitForSelector('.list-error:disabled');
    assert.deepEqual([await lookup.locator('.list-error').textContent(), await lookup.locator('.list-error').getAttribute('title')],
        ['⚠️', 'Tango authentication is unavailable']);
    await lookup.close();
    assert.deepEqual(vaultErrors, []);
    console.log('PASS: Video Vault lists both sites oldest first (XVideos through the app), marks a recording on both, +/- asks the three providers (one hit adds, several ask, none 🔍, failure ⚠️), plays HLS and MP4 across sites, opens restored routes, keeps its last list, signed-out notices, takes over Ptrex pages.');
    await vaultContext.close();

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
            if (url.pathname === '/api/tango/member') return route.fulfill({ headers: pc, json: { member: downloads.includes(url.searchParams.get('identifier')) } });
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
    const tgInject = () => tg.addScriptTag({ content: fs.readFileSync('dist/content/tango-live/content.js', 'utf8') });
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
    // A user scroll disables the overlay until it settles; Follow and Block come back with it.
    await tg.evaluate(() => {
        window.followDisabled = [];
        const follow = document.querySelector('.buttons button[title="Follow or unfollow"]');
        new MutationObserver(() => window.followDisabled.push(follow.disabled)).observe(follow, { attributes: true, attributeFilter: ['disabled'] });
    });
    // A vertical swipe starts navigation (as in scroll-settlement.mjs); touchend + scrollend settle it.
    await tg.evaluate(() => {
        const stage = document.querySelector('.video-stage');
        window.tgTouch = (type, y) => {
            const point = { identifier: 1, target: stage, clientX: 200, clientY: y };
            const event = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperties(event, { touches: { value: type === 'touchend' ? [] : [point] }, changedTouches: { value: [point] } });
            stage.dispatchEvent(event);
        };
        window.tgTouch('touchstart', 400);
        window.tgTouch('touchmove', 350);
    });
    await tg.waitForFunction(() => window.followDisabled.includes(true), null, { timeout: 5000 });
    await tg.evaluate(() => { window.tgTouch('touchend', 350); window.dispatchEvent(new Event('scrollend')); });
    await tg.waitForFunction(() => !document.querySelector('.buttons button[title="Follow or unfollow"]').disabled
        && !document.querySelector('.buttons button[title="Block"]').disabled, null, { timeout: 5000 });
    await tg.waitForFunction(() => document.querySelector('.current-scope video')?.src.endsWith('/B.m3u8'));
    await tg.locator('.buttons button[title="Follow or unfollow"]').click();
    await tg.waitForFunction(() => document.querySelector('.buttons button[title="Follow or unfollow"]').textContent === '🤍');
    await tg.locator('.buttons button[title="Follow or unfollow"]').click();
    await tg.waitForFunction(() => document.querySelector('.buttons button[title="Follow or unfollow"]').textContent === '❤️');
    assert.ok(calls.includes('POST /proxycador/api/public/v1/follow/remove B') && calls.includes('POST /proxycador/api/public/v1/follow/add B'),
        'After a scroll, Follow still unfollows and follows');
    await tg.goto('https://tango.me/stream/sC'); await tgInject();
    await tg.waitForFunction(() => document.querySelector('.current-scope video')?.src.endsWith('/E.m3u8'));
    assert.deepEqual(await catalog(), ['B', 'E'], 'An ended stream leaves; the next one takes its place');
    assert.ok(!calls.some(call => call.startsWith('pc ') && !call.includes('/api/tango/')), 'Only the Tango download list is used');
    assert.deepEqual(tgErrors, []);
    await tango.addInitScript({ content: fs.readFileSync('dist/content/tango-live/content.js', 'utf8') });
    const tgEarly = await tango.newPage();
    await tgEarly.goto('https://tango.me/', { waitUntil: 'commit' });
    await tgEarly.waitForSelector('a.video-row');
    assert.equal(await tgEarly.evaluate(() => window.__videoPlatformBoot.entries), 1);
    console.log('PASS: Tango live list, Follow, +/- download list, two-step Block, co-streamers at the bottom, ended streams replaced by the next, document-start takeover.');
    await tango.close();

    const extension = await browser.newContext(options);
    const barErrors = [];
    await extension.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<p id="native">FC2</p>' }));
    const bar = async (reply) => {
        const page = await extension.newPage();
        page.on('pageerror', error => barErrors.push(error.message));
        await page.addInitScript(reply => {
            let list = ['other'];
            window.listCalls = [];
            window.browser = { runtime: { sendMessage: async message => {
                window.listCalls.push([message.action, message.identifier].filter(Boolean).join(' '));
                if (reply) return reply;
                if (message.action === 'add') list = [...list, message.identifier];
                return message.action === 'member' ? { ok: true, status: 200, member: list.includes(message.identifier) } : { ok: true, status: 200 };
            } } };
        }, reply);
        await page.goto('https://live.fc2.com/12345/');
        await page.addScriptTag({ content: fs.readFileSync('dist/extension/fc2-live/content.js', 'utf8') });
        return page;
    };
    const fc2 = await bar(null);
    await fc2.locator('button.list-add:not(:disabled)').click();
    await fc2.waitForSelector('button.list-remove:not(:disabled)');
    assert.equal(await fc2.locator('button.list-remove').textContent(), '➖', 'The bar shows the viewer\'s +/- button');
    assert.deepEqual(await fc2.evaluate(() => window.listCalls), ['member 12345', 'add 12345', 'member 12345']);
    const fc2Down = await bar({ ok: false, status: 0, error: 'Load failed' });
    await fc2Down.waitForSelector('button.list-error:disabled');
    assert.deepEqual([await fc2Down.locator('button').textContent(), await fc2Down.locator('button').getAttribute('title')], ['⚠️', 'Load failed'],
        'As in Tango, an unreachable PC shows ⚠️ with the reason');
    assert.equal(await fc2Down.locator('#native').isVisible(), true, 'The site stays usable below the bar');
    assert.deepEqual(barErrors, []);
    console.log('PASS: FC2/SC live extensions show the viewer\'s +/- download-list button, ⚠️ when the PC is unreachable.');
    await extension.close();

    const local = await browser.newContext(options);
    await mediaFixture(local);
    const writes = [];
    await local.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() !== 'GET') { writes.push(url.pathname); return route.abort(); }
        if (url.pathname === '/api/videos') return route.fulfill({ json: [1,2,3].map(n => ({ filename: `fixture-${n}`, type: 'original', duration: 120, size: 0, isLive: false })) });
        if (/^\/api\/(tango|fc2|sc)\/member$/.test(url.pathname)) return route.fulfill({ json: { member: false } });
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
