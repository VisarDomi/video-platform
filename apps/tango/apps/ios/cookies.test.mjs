import assert from 'node:assert/strict';
import test from 'node:test';
import {readTangoLogin} from './Login/Resources/cookies.js';

function fixture() {
    const reads = [];
    const api = {
        tabs: {query: async () => [{id: 42, url: 'https://www.tango.me/'}]},
        cookies: {
            getAllCookieStores: async () => [{id: 'default', tabIds: []}, {id: 'reading-profile', tabIds: [42]}],
            get: async query => {
                reads.push(query);
                assert.equal(query.storeId, 'reading-profile', 'Never import another Safari profile’s login');
                assert.equal(query.url, 'https://gateway.tango.me/session-service/public/v2/session/web/refresh');
                return {name: query.name, value: 'fixture-only', domain: 'gateway.tango.me',
                    path: query.name === 'Tango-RT' ? '/session-service/public/v2/session/web/refresh' : '/',
                    expirationDate: 2000000000, httpOnly: true};
            }
        }
    };
    return {api, reads};
}

test('imports the active tab’s profile and preserves the restricted refresh path', async () => {
    const {api, reads} = fixture();
    const login = await readTangoLogin(api);
    assert.deepEqual(reads.map(r => r.name), ['Tango-RT', 'Tango-DI', 'Tango-DeviceId', 'Tango-ST', 'Tango-WST']);
    assert.equal(login.cookies[0].path, '/session-service/public/v2/session/web/refresh');
    assert.equal(login.cookies[0].expirationDate, 2000000000);
});

test('never falls back to an unrelated cookie store', async () => {
    const {api, reads} = fixture();
    api.cookies.getAllCookieStores = async () => [{id: 'other', tabIds: [99]}];
    await assert.rejects(readTangoLogin(api), /cookie store/);
    assert.equal(reads.length, 0);
});

test('only runs from an active Tango website tab', async () => {
    const {api, reads} = fixture();
    api.tabs.query = async () => [{id: 42, url: 'https://tango.me.example.org/'}];
    await assert.rejects(readTangoLogin(api), /active Safari tab/);
    assert.equal(reads.length, 0);
});
