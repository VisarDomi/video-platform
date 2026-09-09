import assert from 'node:assert/strict';

export async function testMultipleVideos(page, inject, whileOff) {
    const button = () => page.locator('.multiple-videos');
    const ready = () => page.waitForFunction(() => !!document.querySelector('.current-scope video[src]'));
    await ready();
    assert.equal(await button().getAttribute('aria-pressed'), 'true', 'Multiple videos default to on');
    await page.waitForFunction(() => document.querySelectorAll('.stream-slot video[src]').length > 1);
    await page.evaluate(() => {
        const video = document.querySelector('.current-scope video');
        window.currentBeforeToggle = video;
        video.pause(); video.muted = false; video.currentTime = 12;
    });
    await button().click();
    assert.equal(await button().getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('.stream-slot video[src]').count(), 1, 'Off unloads neighboring media');
    assert.deepEqual(await page.evaluate(() => {
        const v = document.querySelector('.current-scope video');
        return { same: v === window.currentBeforeToggle, paused: v.paused, muted: v.muted, time: v.currentTime };
    }), { same: true, paused: true, muted: false, time: 12 }, 'Toggling neighbors preserves the selected video');
    await page.reload(); await inject(); await ready();
    assert.equal(await button().getAttribute('aria-pressed'), 'false', 'Off survives reload');
    assert.equal(await page.locator('.stream-slot video[src]').count(), 1);
    if (whileOff) {
        await whileOff();
        await ready();
        assert.equal(await page.locator('.stream-slot video[src]').count(), 1, 'Single-video navigation never reloads neighbors');
    }
    // A cached page must pick up a preference changed in another document.
    await page.evaluate(() => {
        localStorage.setItem('stream-viewer-multiple-videos', 'on');
        dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await page.waitForFunction(() => document.querySelectorAll('.stream-slot video[src]').length > 1);
    assert.equal(await button().getAttribute('aria-pressed'), 'true');
    await button().click();
    await button().click();
    await page.waitForFunction(() => document.querySelectorAll('.stream-slot video[src]').length > 1);
    assert.equal(await page.evaluate(() => localStorage.getItem('stream-viewer-multiple-videos')), 'on', 'The UI can re-enable multiple videos');
    console.log('PASS: multiple-video default, unload, persistent off, cached preference restoration, and re-enable.');
}
