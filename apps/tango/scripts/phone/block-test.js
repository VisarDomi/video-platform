(() => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const target = JSON.parse(sessionStorage.getItem('tangoBlockTarget'));
    const button = title => document.querySelector(`.buttons button[title="${title}"]`);
    const test = window.__tangoTest = { steps: [], done: false, error: null, target };
    const log = (step, extra = {}) => test.steps.push({ step, current: document.querySelector('.streamer-name')?.textContent, ...extra });
    const blocklist = () => new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', 'https://gateway.tango.me/abregistrar/connection/v1/blocklist');
        xhr.withCredentials = true;
        xhr.setRequestHeader('Accept', 'application/json; charset=UTF-8');
        xhr.onload = () => { try { const body = JSON.parse(xhr.responseText); resolve(Array.isArray(body) ? body : body.users || []); } catch (e) { reject(e); } };
        xhr.onerror = () => reject(new Error('blocklist failed'));
        xhr.send();
    });
    (async () => {
        try {
            log('start', { blockedBefore: (await blocklist()).includes(target.id) });
            button('Block').click();
            log('first tap', { block: button('Tap again to block')?.textContent ?? null });
            button('Tap again to block').click();
            for (let i = 0; i < 60 && document.querySelector('.streamer-name')?.textContent === target.title; i++) await sleep(250);
            await sleep(1500);
            const inList = JSON.parse(sessionStorage.getItem('video-catalog:tango-live')).videos.some(v => v.filename === target.id);
            log('second tap', { blockedOnServer: (await blocklist()).includes(target.id), stillInList: inList });
            test.done = true;
        } catch (error) { test.error = String(error); test.done = true; }
    })();
    return 'started';
})()
