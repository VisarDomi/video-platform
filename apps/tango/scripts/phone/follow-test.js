(() => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const button = title => document.querySelector(`.buttons button[title="${title}"]`);
    const state = () => ({ current: document.querySelector('.streamer-name')?.textContent, path: location.pathname,
        follow: button('Follow or unfollow')?.textContent, followDisabled: button('Follow or unfollow')?.disabled,
        blockDisabled: (button('Block') || button('Tap again to block'))?.disabled });
    const test = window.__tangoTest = { steps: [], done: false, error: null };
    const log = (step, extra = {}) => test.steps.push({ step, ...state(), ...extra });
    // Tango's own list of followed live streams, as the app reads it.
    const followedLive = () => new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', 'https://gateway.tango.me/recommendator/social/v2/list/following?includeAlias=true');
        xhr.withCredentials = true;
        xhr.setRequestHeader('Accept', 'application/json; charset=UTF-8');
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onload = () => { try { resolve((JSON.parse(xhr.responseText).records || []).map(r => r.anchor?.encryptedAccountId || r.stream?.encryptedAccountId)); } catch (e) { reject(e); } };
        xhr.onerror = () => reject(new Error('following list failed'));
        xhr.send('{}');
    });
    const currentId = () => JSON.parse(sessionStorage.getItem('video-catalog:tango-live')).videos
        .find(v => v.pageUrl === location.pathname)?.filename;
    (async () => {
        try {
            const stage = document.querySelector('.video-stage');
            const touch = (type, y) => {
                const point = { identifier: 1, target: stage, clientX: 200, clientY: y };
                const event = new Event(type, { bubbles: true, cancelable: true });
                Object.defineProperties(event, { touches: { value: type === 'touchend' ? [] : [point] }, changedTouches: { value: [point] } });
                stage.dispatchEvent(event);
            };
            log('start');
            touch('touchstart', 500); touch('touchmove', 300);
            log('swiping');
            window.scrollBy(0, innerHeight); window.dispatchEvent(new Event('scroll'));
            await sleep(500);
            touch('touchend', 300); window.dispatchEvent(new Event('scrollend'));
            await sleep(2000);
            const id = currentId();
            log('settled', { id, onServer: (await followedLive()).includes(id) });
            for (const round of ['first tap', 'second tap']) {
                const before = button('Follow or unfollow').textContent;
                button('Follow or unfollow').click();
                for (let i = 0; i < 60 && button('Follow or unfollow').textContent === before; i++) await sleep(250);
                await sleep(1500);
                log(round, { id, onServer: (await followedLive()).includes(id) });
            }
            test.done = true;
        } catch (error) { test.error = String(error); test.done = true; }
    })();
    return 'started';
})()
