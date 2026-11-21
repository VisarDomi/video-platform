// The file host plug-in's own rules: its config, which URLs are its file pages, which
// hosts the core may contact, the job key, and how a page leads to its media. The
// transfer through the core's queue, against the simulated host over HTTPS, is
// e2e/file-host.e2e.mjs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { SDK_VERSION } from 'sdk';
import { fileHost, readConfig } from '../dist/index.js';

const ORIGIN = 'https://127.0.0.1:18084';
const host = () => fileHost.createFileHost({ config: { origin: ORIGIN, downloadHosts: ['dl.files.test'] } });

test('the plug-in declares the SDK version and refuses a config it cannot use', () => {
    assert.equal(fileHost.sdkVersion, SDK_VERSION);
    assert.equal(fileHost.id, 'file-host');
    for (const config of [{}, { origin: 'http://127.0.0.1:18084' }, { origin: 'https://127.0.0.1:18084/files' }, { origin: 'https://u:p@127.0.0.1' },
        { origin: ORIGIN, downloadHosts: 'dl.files.test' }, { origin: ORIGIN, downloadHosts: ['bad host'] }]) {
        assert.throws(() => fileHost.createFileHost({ config }), /config\./, JSON.stringify(config));
    }
    assert.deepEqual([...readConfig({ origin: ORIGIN, downloadHosts: ['DL.files.test'] }).downloadHosts], ['127.0.0.1', 'dl.files.test']);
});

test('file pages are canonical; other origins, paths and IDs are not this host\'s', () => {
    const files = host();
    assert.equal(files.canonicalPage(`${ORIGIN}/f/m1a7Qx/?ref=x#top`), `${ORIGIN}/f/m1a7Qx`);
    for (const url of [`https://127.0.0.1:18085/f/m1a7Qx`, `https://127.0.0.1/f/m1a7Qx`, `http://127.0.0.1:18084/f/m1a7Qx`,
        `${ORIGIN}/a/day-one`, `${ORIGIN}/f/`, `${ORIGIN}/f/a/b`, `${ORIGIN}/f/..`, 'not a url']) {
        assert.equal(files.canonicalPage(url), null, url);
    }
    assert.equal(files.isAllowedHost(new URL(`${ORIGIN}/dl/x`)), true);
    assert.equal(files.isAllowedHost(new URL('https://dl.files.test/dl/x')), true);
    assert.equal(files.isAllowedHost(new URL('https://192.168.1.1/dl/x')), false);
    const key = files.jobKey(`${ORIGIN}/f/m1a7Qx`);
    assert.match(key, /^[a-f0-9]{24}$/);
    assert.equal(key, createHash('sha256').update('/f/m1a7Qx').digest('hex').slice(0, 24));
});

test('a page leads to its signed media URL through the link API, with the page as referer', async () => {
    const files = host();
    const requests = [];
    const http = {
        async text(url, init = {}) {
            requests.push({ url, init });
            if (url === `${ORIGIN}/f/m1a7Qx`) {
                return '<h1>First round</h1><p><a id="download" class="download-button" href="/download/m1a7Qx" data-file-id="m1a7Qx">Download</a></p>';
            }
            if (url === `${ORIGIN}/api/link`) {
                assert.equal(init.method, 'POST');
                assert.equal(init.headers.Referer, `${ORIGIN}/f/m1a7Qx`);
                assert.deepEqual(JSON.parse(init.body), { id: 'm1a7Qx' });
                return JSON.stringify({ url: 'https://dl.files.test/dl/m1a7Qx/First%20round.mp4?exp=1&sig=s', name: 'First round.mp4', size: 10 });
            }
            throw new Error(`unexpected ${url}`);
        },
    };
    assert.deepEqual(await files.resolve(`${ORIGIN}/f/m1a7Qx`, http),
        { url: 'https://dl.files.test/dl/m1a7Qx/First%20round.mp4?exp=1&sig=s', filename: 'First round.mp4' });
    assert.equal(requests.length, 2);

    const page = (html, link = '{}') => ({ text: async (url) => (url.endsWith('/api/link') ? link : html) });
    await assert.rejects(files.resolve(`${ORIGIN}/f/m1a7Qx`, page('<p>Just a moment</p>')), /no download button/);
    await assert.rejects(files.resolve(`${ORIGIN}/f/m1a7Qx`, page('<a id="download" data-file-id="m1a7Qx">', 'oops')), /JSON/);
    await assert.rejects(files.resolve(`${ORIGIN}/f/m1a7Qx`, page('<a id="download" data-file-id="m1a7Qx">', '{"url":"x"}')), /without a URL and a name/);
    await assert.rejects(files.resolve('https://elsewhere.test/f/m1a7Qx', page('')), /file page of this host/);
});
