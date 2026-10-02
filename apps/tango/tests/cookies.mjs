import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs';
import vm from 'node:vm';
const built = await build({ entryPoints: ['extension/cookies.ts'], bundle: true, write: false, format: 'esm' });
const { startCookiePersistence } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const untilIdle = () => new Promise(resolve => setImmediate(resolve));
const cookie = { name: 'session_token_auth', value: 'fixture-auth', domain: '.xvideos.com', path: '/', storeId: '0', hostOnly: false, secure: true, httpOnly: true, session: true, sameSite: 'no_restriction' };
function fixture() {
    const state = { auth: { ...cookie }, session: { ...cookie, name: 'session_token', session: false, expirationDate: Date.now() / 1000 + 86400 }, writes: [], changed: null, startup: null, installed: null, completed: null };
    const api = {
        cookies: {
            getAllCookieStores: async () => [{ id: '0', incognito: false }],
            get: async ({ name }) => name === cookie.name ? state.auth : state.session,
            set: async details => { state.writes.push(details); state.auth = { ...state.auth, ...details, session: false }; return state.auth; },
            onChanged: { addListener: listener => { state.changed = listener; } },
        },
        runtime: { onInstalled: { addListener: listener => { state.installed = listener; } }, onStartup: { addListener: listener => { state.startup = listener; } } },
        webRequest: { onCompleted: { addListener: listener => { state.completed = listener; } } },
    };
    return { state, api };
}
{
    const { state, api } = fixture();
    startCookiePersistence(api); await untilIdle();
    assert.equal(state.writes.length, 1);
    assert.deepEqual(state.writes[0], { url: 'https://www.xvideos.com/', name: cookie.name, value: cookie.value, domain: cookie.domain, path: '/', storeId: '0', secure: true, httpOnly: true, sameSite: cookie.sameSite, expirationDate: state.session.expirationDate });
    state.startup(); await untilIdle();
    assert.equal(state.writes.length, 1, 'Already persistent cookies are left alone');
    state.auth = { ...cookie, value: 'rotated-fixture' };
    state.changed({ removed: false, cookie: state.auth }); await untilIdle();
    assert.equal(state.writes.length, 2, 'Renewed session-only auth cookies are preserved');
    state.auth = { ...cookie, value: 'response-renewed-fixture' };
    state.completed(); await untilIdle();
    assert.equal(state.writes.length, 3, 'Safari response events preserve renewed cookies without cookies.onChanged');
    state.auth = null;
    state.changed({ removed: true, cookie }); await untilIdle();
    state.startup(); await untilIdle();
    state.completed(); await untilIdle();
    assert.equal(state.writes.length, 3, 'Explicit logout is never restored from a backup');
}
for (const change of [s => { s.session = null; }, s => { s.session.expirationDate = 1; }, s => { s.auth.httpOnly = false; }, s => { s.auth.storeId = 'private'; }]) {
    const { state, api } = fixture(); change(state);
    startCookiePersistence(api); await untilIdle();
    assert.equal(state.writes.length, 0, 'Do not invent expiry or persist unrelated/unprotected cookies');
}
{
    const { state, api } = fixture();
    state.auth.storeId = state.session.storeId = 'persistent-2';
    api.cookies.getAllCookieStores = async () => [
        { id: 'persistent-1', incognito: false },
        { id: 'persistent-2', incognito: false },
        { id: 'private', incognito: true },
    ];
    const reads = [];
    api.cookies.get = async ({ name, storeId }) => {
        reads.push(storeId);
        return storeId !== 'persistent-2' ? null : name === cookie.name ? state.auth : state.session;
    };
    startCookiePersistence(api); await untilIdle();
    assert.equal(state.writes.length, 1, 'Persist the signed-in Safari profile even when the default store is empty');
    assert.equal(state.writes[0].storeId, 'persistent-2');
    assert.ok(!reads.includes('private'), 'Never inspect private cookie stores');
}
{
    const { state, api } = fixture();
    startCookiePersistence(api);
    state.changed({ removed: true, cookie });
    await untilIdle();
    assert.equal(state.writes.length, 0, 'Logout cancels an in-flight cookie read');
}
{
    const { state, api } = fixture();
    api.extension = { inIncognitoContext: true };
    startCookiePersistence(api); await untilIdle();
    assert.equal(state.writes.length, 0);
}
{
    const { state, api } = fixture();
    // Run the real combined bundle with no window/document: only its cookie
    // worker may execute. No webpage storage or credential messaging exists.
    vm.runInNewContext(fs.readFileSync('dist/extension/content.js', 'utf8'), { browser: api, console, Date });
    await untilIdle();
    assert.equal(state.writes.length, 1);
    const manifest = JSON.parse(fs.readFileSync('dist/extension/manifest.json', 'utf8'));
    assert.equal(manifest.background.service_worker, 'content.js');
    assert.deepEqual(manifest.background.scripts, ['content.js']);
    assert.equal(manifest.background.persistent, false);
    assert.deepEqual(manifest.permissions, ['cookies', 'webRequest']);
}
{
    const { state, api } = fixture();
    vm.runInNewContext(fs.readFileSync('dist/extension/content.js', 'utf8'), {
        browser: api, console, Date, window: {}, location: { protocol: 'safari-web-extension:' },
    });
    await untilIdle();
    assert.equal(state.writes.length, 1, 'Safari background documents run the cookie helper too');
}
console.log('PASS: private HttpOnly cookie persistence, expiry/attribute preservation, token rotation, logout, and worker startup.');
