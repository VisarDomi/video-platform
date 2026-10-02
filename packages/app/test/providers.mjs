import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webkit } from 'playwright-core';
import { testScrollSettlement } from './scroll-settlement.mjs';

// Isolated WebKit fixtures exercise the built frontend. Real iPhone HLS and
// trusted momentum are checked separately against the installed extension.
const extension = fs.readFileSync('dist/extension/xvideos/content.js', 'utf8');
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
