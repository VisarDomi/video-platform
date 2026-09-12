import assert from 'node:assert/strict';
import { testMultipleVideos } from './multiple-videos.mjs';
import fs from 'node:fs';
import { build } from 'esbuild';
import { testScrollSettlement } from './scroll-settlement.mjs';
import { chromium } from '../../../manga/gallery-downloader/node_modules/playwright-core/index.mjs';

const module = await build({ entryPoints: ['src/provider/xvideos/provider.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
const { highestVariant, fullQualityMaster } = await import('data:text/javascript;base64,' + Buffer.from(module.outputFiles[0].text).toString('base64'));
assert.equal(fullQualityMaster('https://media.invalid/signed/hls_low.m3u8?token=fixture'), 'https://media.invalid/signed/hls.m3u8?token=fixture');
assert.equal(fullQualityMaster('https://media.invalid/signed/hls.m3u8?token=fixture'), 'https://media.invalid/signed/hls.m3u8?token=fixture');
const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1280x720
720.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3500000,RESOLUTION=1920x1080
1080.m3u8?token=fixture
#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=640x360
360.m3u8`;
assert.deepEqual(highestVariant(master, 'https://media.invalid/hls/master.m3u8'), { url: 'https://media.invalid/hls/1080.m3u8?token=fixture', quality: '1080p' });
assert.equal(highestVariant(master + '\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\n1080-b.m3u8', 'https://media.invalid/hls/master.m3u8').url, 'https://media.invalid/hls/1080-b.m3u8');
assert.throws(() => highestVariant('<html>Login</html>', 'https://media.invalid/master.m3u8'));
assert.throws(() => highestVariant('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1', 'https://media.invalid/master.m3u8'));
assert.throws(() => highestVariant('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\njavascript:alert(1)', 'https://media.invalid/master.m3u8'));

const bundle = fs.readFileSync('dist/extension/content.js', 'utf8');
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const requests = [];
    let signedIn = true;
    let failedPage = false;
    let redirectedPage = false;
    let empty = false;
    let unavailable = false;
    let releasePages;
    let pageGate = new Promise(resolve => { releasePages = resolve; });
    const entry = n => `<div id="listing-video-${n}"><p class="title"><a href="/video.fixture${n}/upload_${n}">Upload ${n}</a></p></div>`;
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        requests.push(url);
        if (url.hostname === 'media.invalid') {
            if (url.pathname.endsWith('hls_low.m3u8')) return route.fulfill({ contentType: 'application/vnd.apple.mpegurl', headers: { 'Access-Control-Allow-Origin': '*' }, body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=640x360\n360.m3u8' });
            if (url.pathname.endsWith('hls.m3u8')) return route.fulfill({ contentType: 'application/vnd.apple.mpegurl', headers: { 'Access-Control-Allow-Origin': '*' }, body: master });
            return route.abort();
        }
        if (/^\/account\/uploads(?:\/\d+)?$/.test(url.pathname)) {
            if (url.pathname.endsWith('/1') && pageGate) await pageGate;
            if (!signedIn) return route.fulfill({ contentType: 'text/html', body: '<input type="password"><a class="social-login-icon" data-method="signin">Log in</a>' });
            if (failedPage && url.pathname.endsWith('/1')) return route.fulfill({ status: 503, body: 'Unavailable' });
            if (redirectedPage && url.pathname.endsWith('/1')) return route.fulfill({ contentType: 'text/html', headers: { 'X-Fixture-Final-URL': 'https://www.xvideos.com/account/uploads' }, body: entry(1) });
            let html = '<a href="/account/uploads/new">Upload</a>';
            if (!empty) {
                if (url.pathname.endsWith('/2')) html += entry(3) + '<div class="pagination"><a href="/account/uploads">1</a></div>';
                else if (url.pathname.endsWith('/1')) html += entry(2) + entry(3) + '<div class="pagination"><a href="/account/uploads/2">Next</a></div>';
                else html += entry(1) + entry(2) + '<div class="pagination"><a href="">1</a><a href="/account/uploads/1">2</a><a href="/account/uploads/1">Next</a></div>';
            }
            return route.fulfill({ contentType: 'text/html', body: html });
        }
        if (url.pathname.startsWith('/video.')) {
            if (unavailable && url.pathname.includes('fixture1')) return route.fulfill({ status: 404, body: 'Not found' });
            const n = url.pathname.match(/fixture(\d+)/)[1];
            return route.fulfill({ contentType: 'text/html', body: `<script>html5player.setVideoUrlHigh('https://media.invalid/${n}/720.mp4'); html5player.setVideoHLS('https:\\/\\/media.invalid\\/${n}\\/hls_low.m3u8?token=fixture');</script>` });
        }
        return route.fulfill({ contentType: 'text/html', body: '<p id="native">Original</p>' });
    });
    await context.addInitScript(() => {
        window.paginationAttempts = [];
        const fetch = window.fetch.bind(window);
        window.fetch = async (...args) => {
            if (new URL(args[0], location.href).pathname === '/account/uploads/1') window.paginationAttempts.push(performance.now());
            const response = await fetch(...args);
            // Model a followed redirect without letting a fixture escape to
            // the live website (Playwright routes only the initial request).
            const finalUrl = response.headers.get('X-Fixture-Final-URL');
            if (finalUrl) Object.defineProperty(response, 'url', { value: finalUrl });
            return response;
        };
        Object.defineProperties(HTMLVideoElement.prototype, { videoWidth: { get: () => 1920 }, videoHeight: { get: () => 1080 } });
        const paused = new WeakMap();
        Object.defineProperties(HTMLMediaElement.prototype, { paused: { get() { return paused.get(this) ?? true; } }, duration: { get: () => 120 } });
        HTMLMediaElement.prototype.load = function () { paused.set(this, true); };
        HTMLMediaElement.prototype.pause = function () { paused.set(this, true); };
        HTMLMediaElement.prototype.play = async function () {
            if (!this.getAttribute('src')) throw new Error('No source');
            paused.set(this, false);
        };
        const listen = HTMLMediaElement.prototype.addEventListener;
        HTMLMediaElement.prototype.addEventListener = function (type, ...args) { if (type !== 'error') listen.call(this, type, ...args); };
    });
    const page = await context.newPage();
    const inject = () => page.addScriptTag({ content: bundle });
    await page.goto('https://www.xvideos.com/account/uploads');
    await inject();
    await page.waitForFunction(() => document.querySelectorAll('.stream-row').length === 2);
    assert.deepEqual(await page.locator('.stream-row').allTextContents(), ['Upload 1', 'Upload 2'], 'First page renders while later pages are blocked');
    await page.locator('.stream-row').first().evaluate(row => { window.firstUploadRow = row; });
    assert.ok(await page.evaluate(() => JSON.parse(sessionStorage.getItem('stream-viewer-state')).nextPage));
    releasePages(); pageGate = null;
    await page.waitForFunction(() => document.querySelectorAll('.stream-row').length === 3);
    await page.waitForFunction(() => !JSON.parse(sessionStorage.getItem('stream-viewer-state')).nextPage);
    assert.ok(await page.evaluate(() => window.firstUploadRow === document.querySelector('.stream-row')), 'Later pages append without rebuilding existing rows');
    assert.deepEqual(await page.locator('.stream-row').allTextContents(), ['Upload 1', 'Upload 2', 'Upload 3']);
    assert.equal(await page.locator('#native').count(), 0);
    assert.equal(requests.filter(url => url.pathname === '/account/uploads/1').length, 1);
    assert.equal(requests.filter(url => url.pathname === '/account/uploads/2').length, 1);
    assert.equal(requests.filter(url => url.pathname.startsWith('/video.')).length, 0, 'Listing must not resolve every video');
    const listReads = requests.filter(url => url.pathname.startsWith('/account/uploads')).length;
    await page.locator('.stream-row').first().click();
    await inject();
    await page.waitForFunction(() => document.querySelector('.current-scope video')?.src.includes('1080.m3u8'));
    assert.equal(await page.locator('.playback-status').textContent(), '1080p');
    assert.ok(requests.some(url => url.pathname.endsWith('/hls.m3u8') && url.searchParams.get('token') === 'fixture'), 'Fetch the full master, preserving its signature');
    assert.equal(requests.filter(url => url.pathname.endsWith('/hls_low.m3u8')).length, 0, 'Never rank only the mobile-capped variants');
    assert.equal(await page.locator('button.follow').isVisible(), false);
    assert.equal(await page.locator('button.block').isVisible(), false);
    assert.equal(await page.locator('button.download').isVisible(), false);
    assert.equal(requests.filter(url => url.hostname.includes('tango') || url.port === '9999').length, 0);
    assert.equal(requests.filter(url => url.pathname.startsWith('/account/uploads')).length, listReads + 1, 'Viewer verifies the session without refetching paginated list');
    await page.waitForFunction(() => document.querySelector('.next-scope video')?.src.includes('1080.m3u8'));
    assert.deepEqual(await page.locator('.stream-slot video').evaluateAll(vs => vs.map(v => v.paused)), [true, false, false], 'Multi mode plays the current video and its available neighbor');
    await page.locator('button.play-pause').click();
    assert.equal(await page.locator('.current-scope video').evaluate(v => v.paused), true);
    await page.locator('.current-scope video').evaluate(v => v.dispatchEvent(new Event('durationchange')));
    await page.locator('.seek').evaluate(s => { s.value = '500'; s.dispatchEvent(new Event('input')); });
    assert.equal(await page.locator('.current-scope video').evaluate(v => v.currentTime), 60);
    await testScrollSettlement(page, n => String(n));
    await page.waitForFunction(() => document.querySelector('.current-scope video')?.src.includes('1080.m3u8'));
    assert.deepEqual(await page.locator('.stream-slot video').evaluateAll(vs => vs.map(v => v.paused)), [false, false, false], 'Multi mode keeps the three available videos playing after navigation');
    assert.equal(await page.locator('button.home').count(), 0, 'Use Safari Back to return to uploads');
    await page.goBack();
    await page.waitForURL('**/account/uploads');
    await inject();
    await page.waitForFunction(() => document.querySelectorAll('.stream-row').length === 3);
    assert.equal(requests.filter(url => url.pathname === '/account/uploads/1').length, 1, 'Returning to uploads preserves list order');

    unavailable = true;
    await page.locator('.stream-row').first().click();
    await inject();
    await page.waitForFunction(() => document.querySelector('.retry')?.hidden === false);
    assert.match(await page.locator('.playback-status').textContent(), /unavailable/);
    assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('stream-viewer-state')).streams.length), 3, 'Unavailable uploads must stay in the list');
    unavailable = false;
    await page.locator('button.retry').click();
    await page.waitForFunction(() => document.querySelector('.current-scope video')?.src.includes('1080.m3u8'));

    // Open a video before pagination completes. Resume the persisted cursor in
    // the new document without delaying playback or resetting its pause state.
    pageGate = new Promise(resolve => { releasePages = resolve; });
    await page.goto('https://www.xvideos.com/account/uploads');
    await page.evaluate(() => sessionStorage.clear());
    await inject();
    await page.waitForFunction(() => document.querySelectorAll('.stream-row').length === 2);
    await page.locator('.stream-row').first().click();
    await inject();
    await page.waitForFunction(() => document.querySelector('.current-scope video')?.src.includes('1080.m3u8'));
    assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('stream-viewer-state')).streams.length), 2);
    await page.locator('button.play-pause').click();
    failedPage = true;
    releasePages(); pageGate = null;
    await page.waitForFunction(() => window.paginationAttempts.length >= 2);
    failedPage = false;
    await page.waitForFunction(() => {
        const state = JSON.parse(sessionStorage.getItem('stream-viewer-state'));
        return state.streams.length === 3 && !state.nextPage;
    });
    assert.equal(await page.locator('.current-scope video').evaluate(v => v.paused), true, 'Automatic pagination recovery in the viewer must not resume paused playback');
    await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
        const state = JSON.parse(sessionStorage.getItem('stream-viewer-state'));
        state.currentStreamerId = '2';
        sessionStorage.setItem('stream-viewer-state', JSON.stringify(state));
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('stream-viewer-state')).currentStreamerId), '1', 'Restoring a cached video restores its selection into shared state');
    assert.equal(await page.locator('.current-scope video').evaluate(v => v.paused), true, 'Restoring the same cached video keeps its pause state');
    await page.goBack(); await inject();
    await page.waitForFunction(() => document.querySelectorAll('.stream-row').length === 3);
    assert.deepEqual(await page.locator('.stream-row').allTextContents(), ['Upload 1', 'Upload 2', 'Upload 3']);

    // Model a cached list whose newer video document finished pagination. A
    // response from the paused list must not overwrite that newer shared state.
    pageGate = new Promise(resolve => { releasePages = resolve; });
    await page.reload(); await inject();
    await page.waitForFunction(() => document.querySelectorAll('.stream-row').length === 2);
    await page.evaluate(() => {
        window.cachedFirstRow = document.querySelector('.stream-row');
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
        const state = JSON.parse(sessionStorage.getItem('stream-viewer-state'));
        state.streams.push({ ...state.streams[0], streamerId: '3', streamId: '/video.fixture3/upload_3', firstName: 'Upload 3' });
        delete state.nextPage;
        state.currentStreamerId = '2';
        sessionStorage.setItem('stream-viewer-state', JSON.stringify(state));
    });
    releasePages(); pageGate = null;
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.stream-row').count(), 2, 'A paused response cannot append into the cached page');
    assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('stream-viewer-state')).streams.length), 3);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await page.waitForFunction(() => document.querySelectorAll('.stream-row').length === 3);
    assert.ok(await page.evaluate(() => window.cachedFirstRow === document.querySelector('.stream-row')), 'bfcache reconciliation keeps existing row nodes');
    assert.equal(await page.locator('.stream-row.current').textContent(), 'Upload 2');
    assert.equal(await page.locator('.uploads-progress').count(), 0);

    // A hidden tab resumes its unfinished cursor once visible again.
    pageGate = new Promise(resolve => { releasePages = resolve; });
    await page.reload(); await inject();
    await page.waitForFunction(() => document.querySelectorAll('.stream-row').length === 2);
    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    releasePages(); pageGate = null;
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.stream-row').count(), 2);
    await page.evaluate(() => {
        delete document.hidden;
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => document.querySelectorAll('.stream-row').length === 3 && !document.querySelector('.uploads-progress'));

    for (const path of ['/account/uploads/new', '/account/uploads/1/edit', '/account/uploads/delete', '/']) {
        await page.goto('https://www.xvideos.com' + path);
        const before = requests.length;
        await inject();
        assert.equal(await page.locator('#native').textContent(), 'Original');
        assert.equal(await page.evaluate(() => window.__streamViewerExtensionBoot), undefined);
        assert.equal(requests.length, before);
    }
    signedIn = false;
    await page.goto('https://www.xvideos.com/account/uploads');
    await page.evaluate(() => sessionStorage.clear());
    await inject();
    await page.waitForURL('**/account');
    await inject();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#native').textContent(), 'Original', 'Expired login redirects to a usable native account page');
    assert.equal(await page.locator('.status-error').count(), 0);
    assert.equal(await page.evaluate(() => window.__streamViewerExtensionBoot.shellAt), undefined, 'The dedicated login page stays native');
    signedIn = true;
    await page.waitForURL('**/account/uploads');
    await inject();
    await page.waitForFunction(() => document.querySelectorAll('.stream-row').length === 3);
    failedPage = true;
    await page.evaluate(() => sessionStorage.clear());
    await page.reload(); await inject();
    await page.waitForFunction(() => document.querySelector('.uploads-progress')?.textContent.includes('Retrying automatically'));
    assert.equal(await page.locator('.stream-row').count(), 2, 'A later-page error preserves the usable first page');
    assert.ok(await page.evaluate(() => JSON.parse(sessionStorage.getItem('stream-viewer-state')).nextPage), 'Failed pagination retains its resume cursor');
    assert.equal(await page.locator('.retry-pages').count(), 0, 'Pagination never asks the user to retry');
    await page.waitForFunction(() => window.paginationAttempts.length >= 3);
    const attempts = await page.evaluate(() => window.paginationAttempts);
    assert.ok(attempts[1] - attempts[0] >= 900, 'First automatic retry waits about one second');
    assert.ok(attempts[2] - attempts[1] >= 1900, 'Repeated failures back off');
    failedPage = false;
    await page.waitForFunction(() => document.querySelectorAll('.stream-row').length === 3 && !document.querySelector('.uploads-progress'));
    failedPage = true;
    await page.reload(); await inject();
    await page.waitForFunction(() => document.querySelector('.uploads-progress')?.textContent.includes('Retrying automatically'));
    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    const pausedAttempts = await page.evaluate(() => window.paginationAttempts.length);
    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(() => window.paginationAttempts.length), pausedAttempts, 'Hiding the page cancels its pending retry timer');
    failedPage = false;
    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => document.querySelectorAll('.stream-row').length === 3 && !document.querySelector('.uploads-progress'));
    redirectedPage = true;
    await page.reload(); await inject();
    await page.waitForFunction(() => document.querySelector('.uploads-progress')?.textContent.includes('Retrying automatically'));
    assert.equal(await page.locator('.stream-row').count(), 2);
    assert.ok(await page.evaluate(() => JSON.parse(sessionStorage.getItem('stream-viewer-state')).nextPage), 'A redirect must not mark an incomplete catalog complete');
    redirectedPage = false;
    await page.waitForFunction(() => document.querySelectorAll('.stream-row').length === 3 && !document.querySelector('.uploads-progress'));
    await page.setViewportSize({ width: 390, height: 100 });
    await page.evaluate(() => { window.scrollTo(0, 40); document.querySelector('.stream-row').click(); });
    await page.waitForURL('**/video.fixture1/upload_1');
    await inject();
    await page.waitForFunction(() => document.querySelector('.current-scope video')?.src.includes('1080.m3u8'));
    await page.goBack(); await inject();
    await page.waitForFunction(() => document.querySelectorAll('.stream-row').length === 3);
    assert.equal(await page.evaluate(() => window.scrollY), 40, 'A rebuilt Back document restores the list history entry scroll position');
    await page.setViewportSize({ width: 390, height: 844 });
    empty = true;
    await page.reload(); await inject();
    await page.waitForSelector('.status');
    await page.waitForFunction(() => document.querySelector('.status')?.textContent === 'No uploads yet.');
    empty = false;
    await page.goto('https://www.xvideos.com/video.fixture1/upload_1'); await inject();
    await testMultipleVideos(page, inject, () => testScrollSettlement(page, n => String(n)));
    console.log('PASS: XVideos pagination, deduplication, lazy highest-quality playback, VOD controls, stable list, retry, automatic login takeover/management isolation, and incomplete-list errors.');
} finally { await browser.close(); }
