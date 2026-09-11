import assert from 'node:assert/strict';

// Drive the production UI with deterministic touch/scroll boundaries. This is
// not a simulation of iOS momentum: the physical flick still needs native Safari.
export async function testScrollSettlement(page, itemId = n => `person-${n}`) {
    await page.evaluate(() => {
        const stage = document.querySelector('.stream-stage');
        for (const video of stage.querySelectorAll('video')) video.style.height = '600px';
        const originalScrollBy = window.scrollBy;
        window.fixtureScrollWrites = [];
        window.scrollBy = (...args) => {
            window.fixtureScrollWrites.push(args);
            originalScrollBy.apply(window, args);
        };
        // No native scrollend is available to the viewer in this experiment.
        window.addEventListener('scrollend', event => {
            if (event.isTrusted) event.stopImmediatePropagation();
        }, true);
        window.fixtureTouch = (type, y = 400) => {
            const point = new Touch({identifier: 1, target: stage, clientX: 200, clientY: y});
            stage.dispatchEvent(new TouchEvent(type, {
                bubbles: true, cancelable: true,
                touches: type === 'touchend' ? [] : [point], changedTouches: [point],
            }));
        };
        window.fixtureScroll = top => {
            window.scrollTo(0, top);
            window.dispatchEvent(new Event('scroll'));
        };
        const rect = stage.querySelector('.current-scope video').getBoundingClientRect();
        window.scrollTo(0, window.scrollY + rect.top + rect.height / 2 - innerHeight / 2);
    });
    await page.waitForTimeout(60);
    const read = () => page.evaluate(() => {
        const stage = document.querySelector('.stream-stage');
        const video = stage.querySelector('.current-scope video');
        const rect = video.getBoundingClientRect();
        return {
            id: JSON.parse(sessionStorage.getItem('stream-viewer-state')).currentStreamerId,
            navigating: stage.classList.contains('viewer-navigating'),
            writes: window.fixtureScrollWrites.length,
            center: rect.top + rect.height / 2,
            midpoint: innerHeight / 2,
            visible: !video.hidden && rect.top <= innerHeight / 2 && rect.bottom > innerHeight / 2,
        };
    });
    const begin = () => page.evaluate(() => {
        window.fixtureTouch('touchstart');
        window.fixtureTouch('touchmove', 350);
        window.fixtureScrollWrites.length = 0;
    });
    const end = async () => {
        // Deliver queued movement before releasing contact. No scrollend signal.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.evaluate(() => {
            window.fixtureTouch('touchend', 350);
        });
        await page.waitForFunction(() => !document.querySelector('.stream-stage').classList.contains('viewer-navigating'));
    };
    const settle = async () => {
        await end();
        // Let the normalization's own scroll event finish before another gesture.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const result = await read();
        assert.equal(result.navigating, false);
        assert.equal(result.visible, true, 'Settlement must leave a real video under the midpoint');
        return result;
    };
    const spacer = direction => page.evaluate(direction => {
        window.fixtureScroll(window.scrollY + direction * 3000);
    }, direction);

    await begin();
    const preserved = await page.evaluate(() => {
        const next = document.querySelector('.next-scope video');
        const rect = next.getBoundingClientRect();
        const delta = rect.top + rect.height / 2 - innerHeight / 2;
        const expected = rect.top - delta;
        window.fixtureScroll(window.scrollY + delta);
        return {sameVideo: next === document.querySelector('.current-scope video'),
            expected, actual: next.getBoundingClientRect().top};
    });
    assert.equal(preserved.sameVideo, true, 'Recycle the same playing element');
    assert.ok(Math.abs(preserved.actual - preserved.expected) < 1, 'Recycling must preserve the visible position');
    assert.equal((await read()).id, itemId(2));
    assert.equal((await read()).writes, 0, 'Midpoint selection must not interrupt native momentum');
    await page.evaluate(() => window.dispatchEvent(new Event('scrollend')));
    await page.waitForTimeout(150);
    assert.equal((await read()).navigating, true, 'A held finger must prevent settlement');
    assert.equal((await settle()).id, itemId(2), 'A video landing must not advance again');

    await begin();
    await spacer(1);
    assert.equal((await read()).id, itemId(2), 'Blank space is not itself a stream');
    assert.equal((await read()).writes, 0);
    let result = await settle();
    assert.equal(result.id, itemId(3), 'Downward spacer landing selects only the next entry');
    assert.ok(Math.abs(result.center - result.midpoint) < 1);

    await begin();
    await spacer(1);
    assert.equal((await settle()).id, itemId(3), 'No next stream: retain the last real entry');
    await begin();
    await spacer(-1);
    assert.equal((await settle()).id, itemId(2), 'Upward spacer landing selects only the previous entry');

    await begin();
    await spacer(1);
    await page.evaluate(() => window.fixtureScroll(window.scrollY - 200));
    assert.equal((await settle()).id, itemId(1), 'A direction reversal in blank space follows the final direction');
    await begin();
    await spacer(-1);
    assert.equal((await settle()).id, itemId(1), 'No previous stream: retain the first real entry');

    await begin();
    await spacer(1);
    await page.evaluate(() => window.fixtureTouch('touchend', 350));
    // Finger release is not the end of momentum; keep changing position.
    await page.evaluate(() => new Promise(resolve => {
        let frames = 0;
        const move = () => {
            window.fixtureScroll(window.scrollY + 10);
            if (++frames < 12) requestAnimationFrame(move);
            else resolve();
        };
        requestAnimationFrame(move);
    }));
    assert.equal((await read()).writes, 0, 'Changing position after release must not trigger a correction');
    assert.equal((await read()).navigating, true);
    assert.equal((await settle()).id, itemId(2));

    await begin();
    await spacer(1);
    await page.evaluate(() => window.dispatchEvent(new Event('scrollend')));
    assert.equal((await read()).writes, 0, 'A held finger prevents immediate settlement');
    await page.evaluate(() => window.fixtureScroll(window.scrollY + 100));
    await page.evaluate(() => window.fixtureTouch('touchend', 350));
    await page.waitForTimeout(40);
    assert.equal((await read()).writes, 0, 'An early scrollend must not bypass position settling');
    result = await settle();
    assert.equal(result.id, itemId(3));
    await begin();
    for (const [role, id] of [['previous', itemId(2)], ['previous', itemId(1)], ['next', itemId(2)]]) {
        await page.evaluate(role => {
            const video = document.querySelector(`.${role}-scope video`);
            const rect = video.getBoundingClientRect();
            window.fixtureScroll(window.scrollY + rect.top + rect.height / 2 - innerHeight / 2);
        }, role);
        assert.equal((await read()).id, id, 'Multiple crossings and reversal must preserve stream order');
        assert.equal((await read()).writes, 0, 'Every recycling step must leave native momentum alone');
    }
    assert.equal((await settle()).id, itemId(2));
    console.log('PASS: settlement without scrollend; midpoint continuity without scroll writes; held touch and changing-position guards; video/spacer landings; next/previous, reversal and list limits.');
}
