import assert from 'node:assert/strict';
import fs from 'node:fs';

export async function testFc2Login(browser, options) {
    const script = fs.readFileSync('dist/extension/fc2-live/content.js', 'utf8');
    const context = await browser.newContext(options);
    const errors = [];
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `
        <a href="https://id.fc2.com/login/">FC2 ID</a>
        <a href="/login/help">Login help</a>
        <a href="/login/" hidden>Hidden desktop login</a>
        <a href="/login/" style="position:absolute;left:-1000px">Offscreen mobile menu login</a>
        <button type="submit" form="credentials">Login</button>
        <form id="credentials"><input name="password" type="password"></form>
        <main id="header"></main>` }));
    await context.addInitScript(() => {
        window.loginClicks = [];
        window.formSubmits = 0;
        window.browser = { runtime: { sendMessage: async () => ({ ok: true, member: false }) } };
        document.addEventListener('click', event => {
            window.loginClicks.push(event.target.closest('a')?.href ?? 'button');
            event.preventDefault();
        });
        document.addEventListener('submit', event => { window.formSubmits++; event.preventDefault(); });
    });
    try {
        for (const [path, label] of [['/', 'Login'], ['/12345/', 'ログイン']]) {
            const page = await context.newPage();
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(`https://live.fc2.com${path}`);
            await page.addScriptTag({ content: script });
            assert.deepEqual(await page.evaluate(() => window.loginClicks), [], 'Ignore hidden, unrelated and credential controls');
            // The mobile header can render late, then become visible through a CSS change.
            await page.locator('#header').evaluate((header, label) => {
                header.innerHTML = `<a href="/login/?done=livechat&switch_language=en" style="display:none">${label}</a>`;
            }, label);
            await page.locator('#header a').evaluate(link => { link.style.display = 'inline'; });
            await page.waitForFunction(() => window.loginClicks.length === 1);
            assert.deepEqual(await page.evaluate(() => window.loginClicks), ['https://live.fc2.com/login/?done=livechat&switch_language=en'],
                'Click the site link with its existing return URL in either language');
            await page.locator('#header').evaluate(header => { header.innerHTML += '<p>Page updated</p>'; });
            // A second render must not keep clicking if the first navigation was cancelled.
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            assert.equal(await page.evaluate(() => window.loginClicks.length), 1);
            assert.equal(await page.evaluate(() => window.formSubmits), 0);
            await page.reload();
            await page.evaluate(() => { Date.now = () => 2_000_000_000_000; });
            await page.locator('#header').evaluate(header => { header.innerHTML = '<a href="/login/">Login</a>'; });
            await page.addScriptTag({ content: script });
            assert.deepEqual(await page.evaluate(() => window.loginClicks), [], 'A failed login round trip cannot cause a redirect loop');
            await page.close();
        }
        const login = await context.newPage();
        await login.goto('https://live.fc2.com/login/');
        await login.locator('#header').evaluate(header => { header.innerHTML = '<a href="/login/">Login</a>'; });
        await login.addScriptTag({ content: script });
        assert.deepEqual(await login.evaluate(() => window.loginClicks), [], 'Leave the login page itself to Safari');
        assert.deepEqual(errors, []);
        console.log('PASS: FC2 automatically clicks visible Login links, handles late rendering and prevents repeat redirects.');
    } finally { await context.close(); }
}
