import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { webkit } from 'playwright-core';
import { testScrollSettlement } from './scroll-settlement.mjs';

// Isolated WebKit fixtures exercise the built website (the local lists and their web viewer)
// and the FC2/SC live Safari extensions. The iPhone apps are native (apps/ios).
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
