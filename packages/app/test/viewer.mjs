import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { testScrollSettlement } from './scroll-settlement.mjs';

// Load the deployed app, with isolated API/media fixtures. No library mutation
// is permitted. Native iPhone momentum/HLS acceptance remains a physical test.
const origin = process.env.VIDEO_TEST_ORIGIN ?? 'https://192.168.1.197:9999';
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
try {
    const context = await browser.newContext({
        ignoreHTTPSErrors: true, viewport: { width: 428, height: 800 },
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/26.6.1 Mobile/15E148 Safari/604.1',
    });
    const records = [1, 2, 3].map(n => ({ filename: `fixture-${n}`, type: 'original', duration: 600, size: 1000, isLive: false }));
    const writes = [];
    await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() !== 'GET') {
            writes.push(request.url());
            return route.abort();
        }
        if (url.pathname === '/api/videos') return route.fulfill({ json: records });
        if (url.pathname === '/api/tango/list') return route.fulfill({ json: [] });
        if (url.pathname.startsWith('/api/')) return route.abort();
        if (url.pathname.startsWith('/hls/')) {
            if (!url.pathname.endsWith('.m3u8')) return route.abort();
            return route.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXT-X-TARGETDURATION:600\n#EXTINF:600,\nfixture.ts\n#EXT-X-ENDLIST\n' });
        }
        if (url.origin !== new URL(origin).origin) return route.abort();
        return route.continue();
    });
    await context.addInitScript(() => {
        Object.defineProperties(HTMLVideoElement.prototype, {
            videoWidth: { get: () => 428 }, videoHeight: { get: () => 600 },
        });
        Object.defineProperties(HTMLMediaElement.prototype, {
            readyState: { get: () => 4 }, duration: { get: () => 600 },
            seekable: { get: () => ({ length: 1, start: () => 0, end: () => 600 }) },
        });
        HTMLMediaElement.prototype.load = function () {
            if (this.getAttribute('src')) queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')));
        };
        HTMLMediaElement.prototype.play = async function () {};
        HTMLMediaElement.prototype.pause = function () {};
        const listen = HTMLMediaElement.prototype.addEventListener;
        HTMLMediaElement.prototype.addEventListener = function (type, ...args) {
            if (type !== 'error') listen.call(this, type, ...args);
        };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/videos/tango`);
    await page.waitForSelector('a.video-row');
    const homeHistory = await page.evaluate(() => history.length);
    await page.locator('a.video-row').first().click();
    await page.waitForSelector('.video-stage:not(.viewer-loading)');
    await page.waitForFunction(() => document.querySelector('.list-add:not(:disabled)'));
    assert.equal(await page.evaluate(() => history.length), homeHistory + 1);
    const viewerHistory = homeHistory + 1;
    assert.equal(await page.locator('.player-scope').count(), 3);
    await page.evaluate(() => { document.querySelector('.current-scope video').currentTime = 42; });
    await page.getByRole('button', { name: '📍', exact: true }).click();
    assert.equal(await page.locator('.segment-marker').count(), 1, 'Editing markers still work');
    await testScrollSettlement(page);
    assert.equal(await page.locator('.segment-marker').count(), 0, 'Changing video clears the previous video markers');
    assert.equal(await page.evaluate(() => localStorage.getItem('video-progress-fixture-1')), '42', 'Recycling preserves outgoing playback progress');
    assert.equal(await page.evaluate(() => history.length), viewerHistory, 'Viewer changes replace URL without extra Back steps');
    assert.ok(page.url().endsWith('/fixture-2?type=original'));
    await page.getByRole('button', { name: '🔇', exact: true }).click();
    assert.equal(await page.locator('.current-scope video').evaluate(v => v.muted), false);
    const seek = await page.evaluate(() => {
        const stage = document.querySelector('.video-stage'), video = stage.querySelector('.current-scope video');
        const before = video.currentTime;
        const touch = x => new Touch({ identifier: 3, target: stage, clientX: x, clientY: 100 });
        stage.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(100)], changedTouches: [touch(100)], bubbles: true }));
        stage.dispatchEvent(new TouchEvent('touchmove', { touches: [touch(200)], changedTouches: [touch(200)], bubbles: true, cancelable: true }));
        stage.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [touch(200)], bubbles: true }));
        return { before, after: video.currentTime };
    });
    assert.ok(seek.after > seek.before, 'Horizontal seeking remains available');
    await page.goBack();
    await page.waitForSelector('a.video-row');
    assert.equal(new URL(page.url()).pathname, '/videos/tango');
    assert.deepEqual(writes, [], 'No edit, save, or membership mutation may reach the real server');
    assert.deepEqual(errors, []);
    console.log('PASS: deployed frontend; native list/URL navigation; outgoing progress, marker reset, mute and horizontal seek; no server mutations.');
} finally {
    await browser.close();
}
