import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launchPageBrowser } from './support/browser.mjs';
import { testScrollSettlement } from './scroll-settlement.mjs';

// Isolated browser fixtures exercise the built website (the local lists and their web viewer)
// in the system's Chromium (WebKit by opt-in, see support/browser.mjs). The sites are the
// server's (GET /api/sites); here three neutral ones.
const web = 'packages/app/build';
const browser = await launchPageBrowser({ headless: true });
const SITES = [{ id: 'live-a', label: 'Live A', list: true }, { id: 'live-b', label: 'Live B', list: true }, { id: 'live-c', label: 'Live C', list: true }];
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

    const local = await browser.newContext(options);
    await mediaFixture(local);
    const writes = [];
    let sitesAsked = 0;
    await local.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() !== 'GET') { writes.push(url.pathname); return route.abort(); }
        // The first answer is an older server's page instead of the list: the site waits and asks again.
        if (url.pathname === '/api/sites') return sitesAsked++ === 0
            ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><p>app</p>' })
            : route.fulfill({ json: { sites: SITES } });
        if (url.pathname === '/api/videos') return route.fulfill({ json: [1,2,3].map(n => ({ filename: `fixture-${n}`, type: 'original', duration: 120, size: 0, isLive: false })) });
        if (/^\/api\/live-[abc]\/member$/.test(url.pathname)) return route.fulfill({ json: { member: false } });
        if (url.pathname.startsWith('/hls/')) return route.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXTINF:120,\nfixture.ts\n#EXT-X-ENDLIST\n' });
        const file = path.join(web, url.pathname.startsWith('/assets/') ? url.pathname : 'index.html');
        return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    const localPage = await local.newPage();
    await localPage.goto('https://local.invalid/');
    await localPage.waitForURL('https://local.invalid/videos/live-a');
    assert.ok(sitesAsked >= 2, 'the site list was asked for again after an unusable answer');
    for (const { id: provider } of SITES) {
        await localPage.goto(`https://local.invalid/videos/${provider}`);
        await localPage.locator('a.video-row').first().click();
        await localPage.waitForSelector('.video-stage:not(.viewer-loading)');
        await localPage.waitForSelector('.list-add:not(:disabled)');
        assert.ok(await localPage.locator('.buttons button').filter({ hasText: '📍' }).isVisible());
        assert.match(await localPage.locator('.current-scope video').getAttribute('src'), new RegExp(`/hls/${provider}/fixture-1/playlist.m3u8`));
    }
    await localPage.goto('https://local.invalid/videos/live-a/fixture-1?type=original');
    await localPage.waitForSelector('.video-stage:not(.viewer-loading)');
    await testScrollSettlement(localPage, 'live-a');
    assert.deepEqual(writes, [], 'Fixtures never mutate real libraries');
    console.log('PASS: the root opens the first site; every site\'s list keeps playback/editing controls and shared scrolling.');
    await local.close();
} finally { await browser.close(); }
