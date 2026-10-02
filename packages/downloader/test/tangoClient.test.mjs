import assert from "node:assert/strict";
import test from "node:test";
import { ApiClient } from "../dist/services/tango/api/apiClient.js";
import { PlaylistNotFoundError } from "../dist/services/core/playlistNotFoundError.js";

const client = () => new ApiClient(async () => ({ st: 'test', tt: 'test', ttu: 'test', tte: '9999999999' }));
function mockFetch(t, handler) {
    t.mock.method(globalThis, 'fetch', handler);
}

test('only Tango live playlist 404 propagates as a terminal failure', async (t) => {
    mockFetch(t, async () => new Response('', { status: 404 }));
    const api = client();
    assert.equal(await api.parseMasterPlaylist('https://example.test/master.m3u8'), null);
    await assert.rejects(api.createDownloadSession().fetchPlaylist('https://example.test/live.m3u8'), PlaylistNotFoundError);
});

test('Tango transient failures and segment 404s are not terminal playlist failures', async (t) => {
    const api = client();
    for (const status of [401, 403, 429, 500, 503]) {
        mockFetch(t, async () => new Response('', { status }));
        assert.equal(await api.parseMasterPlaylist('https://example.test/master.m3u8'), null);
        assert.equal(await api.createDownloadSession().fetchPlaylist('https://example.test/live.m3u8'), null);
    }
    mockFetch(t, async () => { throw new Error('network down'); });
    assert.equal(await api.parseMasterPlaylist('https://example.test/master.m3u8'), null);
    mockFetch(t, async () => new Response('', { status: 404 }));
    assert.equal((await api.createDownloadSession().fetchSegment('https://example.test/1.ts')).data, null);
});

test('Tango accepts low-resolution-only masters and chooses highest available resolution', async () => {
    const api = client();
    const master = 'https://example.test/v2/stream/master.m3u8';
    api.getMasterList = async () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=360x640\nlow.m3u8\n';
    assert.equal(await api.parseMasterPlaylist(master), 'https://example.test/v2/stream/low.m3u8');
    api.getMasterList = async () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=720x1280\n/v2/high.m3u8?x=1&\n';
    assert.equal(await api.parseMasterPlaylist(master), 'https://example.test/v2/high.m3u8?x=1');
    api.getMasterList = async () => '#EXTM3U\n#EXTINF:1,\n1.ts\n';
    assert.equal(await api.parseMasterPlaylist(master), master);
});

test('Tango looks up only requested accounts, without any following endpoint', async (t) => {
    const calls = [];
    mockFetch(t, async (url, options) => {
        calls.push({ url: String(url), body: JSON.parse(options.body) });
        return Response.json({ records: ['configured', 'unexpected'].map(accountId => ({
            stream: { encryptedAccountId: accountId, id: 'stream', masterListUrl: 'https://example.test/master.m3u8', status: 'LIVING', streamKind: 'PUBLIC' },
        })) });
    });
    const result = await client().getLiveStreamsByAccountIds(['configured']);
    assert.deepEqual([...result.live.keys()], ['configured']);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/list\/byEncryptedAccountIds\?/);
    assert.deepEqual(calls[0].body.accountIds, ['configured']);
});

test('malformed Tango lookup is unavailable, not an offline snapshot', async (t) => {
    mockFetch(t, async () => Response.json({ error: 'unavailable' }));
    assert.equal(await client().getLiveStreamsByAccountIds(['configured']), null);
});
