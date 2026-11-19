// The core's site plumbing: the sites file, each site's logger and its download list.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const sandbox = await mkdtemp(path.join(os.tmpdir(), 'downloader-sites-'));
process.env.VIDEO_SERVICES_DATA_ROOT = path.join(sandbox, 'data');
test.after(() => rm(sandbox, { recursive: true, force: true }));

const { SDK_VERSION } = await import('sdk');
const { default: logger } = await import('../dist/common/logger.js');
const { siteLogger } = await import('../dist/common/siteLogger.js');
const { TargetManager } = await import('../dist/services/common/targetManager.js');
const { loadCaptureSites, sitesFilePath } = await import('../dist/services/sites.js');

// ---- the site logger ------------------------------------------------------------

test("a site's log lines carry its label as prefix, with their details unchanged", (t) => {
    const lines = [];
    for (const level of ['debug', 'verbose', 'info', 'warn', 'error']) {
        t.mock.method(logger, level, (...args) => lines.push([level, ...args]));
    }
    const log = siteLogger('Site A');
    log.verbose('detail');
    log.info('Loaded 3 targets');
    log.warn('ACCESS_INCIDENT_OPEN', { streamerId: '1' });
    log.debug('quiet');
    log.error('Poll error', { error: 'x' });
    assert.deepEqual(lines, [
        ['verbose', '[Site A] detail'],
        ['info', '[Site A] Loaded 3 targets'],
        ['warn', '[Site A] ACCESS_INCIDENT_OPEN', { streamerId: '1' }],
        ['debug', '[Site A] quiet'],
        ['error', '[Site A] Poll error', { error: 'x' }],
    ]);
});

// ---- the download list ----------------------------------------------------------

// A catalog for "<id> <label>" lines; "?<label>" is an entry without an ID yet.
function fakeCatalog(extra = {}) {
    return {
        parseTargetLine(line) {
            if (line.startsWith('?')) return { id: '', label: line.slice(1) };
            const [id, label] = line.split(' ');
            return id && label ? { id, label } : null;
        },
        formatTargetLine: ({ id, label }) => `${id} ${label}`,
        ...extra,
    };
}

function recordingLog() {
    const lines = [];
    const log = Object.fromEntries(['debug', 'verbose', 'info', 'warn', 'error'].map((level) => [level, (message) => lines.push([level, message])]));
    return { log, lines, info: () => lines.filter(([level]) => level === 'info').map(([, message]) => message) };
}

async function waitFor(check) {
    for (let n = 0; n < 60 && !check(); n++) await sleep(50);
    return check();
}

async function replaceAtomically(file, content) {
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, content);
    await rename(temporary, file);
}

test('a missing list is created with the catalog header, not read; the next change loads it', async (t) => {
    const file = path.join(sandbox, 'lists-a', 'site.txt');
    const { log, lines } = recordingLog();
    const manager = TargetManager.create({ filePath: file, catalog: fakeCatalog({ listHeader: '# one per line: <id> <label>' }), log });
    t.after(() => manager.close());
    assert.equal(await readFile(file, 'utf8'), '# one per line: <id> <label>\n');
    assert.deepEqual(manager.getTargets(), []);
    assert.deepEqual(lines.filter(([level]) => level !== 'debug'), [
        ['warn', `site.txt not found at ${file}. Creating empty file.`],
    ]);
    await replaceAtomically(file, 'a1 alpha\nb2 beta\n');
    assert.ok(await waitFor(() => manager.size === 2));
    assert.deepEqual(lines.filter(([level]) => level === 'info'), [['info', 'Loaded 2 targets']]);
});

test('list entries: comments skipped, a repeated ID keeps its place and takes the last label, unresolved entries kept', async (t) => {
    const file = path.join(sandbox, 'list-b.txt');
    await writeFile(file, '# comment\n\n  a1 alpha  \nb2 beta\r\n?pending\na1 alpha2\nbroken\n');
    const { log, info } = recordingLog();
    const manager = TargetManager.create({ filePath: file, catalog: fakeCatalog(), log });
    t.after(() => manager.close());
    assert.deepEqual(manager.getTargets(), [
        { id: 'a1', label: 'alpha2' }, { id: 'b2', label: 'beta' }, { id: '', label: 'pending' },
    ]);
    assert.equal(manager.size, 3);
    assert.ok(manager.hasTarget('b2'));
    assert.deepEqual(info(), ['Loaded 3 targets']);
});

test('a reload reports changes by ID by default, as "<label> (<id>)": a new label alone is not a change', async (t) => {
    const file = path.join(sandbox, 'list-c.txt');
    await writeFile(file, 'a1 alpha\nb2 beta\n');
    const { log, info } = recordingLog();
    const manager = TargetManager.create({ filePath: file, catalog: fakeCatalog(), log });
    t.after(() => manager.close());
    await replaceAtomically(file, 'a1 alpha_renamed\nc3 c3\n');
    assert.ok(await waitFor(() => manager.hasTarget('c3')));
    assert.deepEqual(info(), ['Loaded 2 targets', 'Added targets: c3 (c3)', 'Removed targets: beta (b2)']);
});

test('a catalog may name its entries itself in those lines', async (t) => {
    const file = path.join(sandbox, 'list-c2.txt');
    await writeFile(file, 'a1 alpha\n');
    const { log, info } = recordingLog();
    const manager = TargetManager.create({ filePath: file, catalog: fakeCatalog({ describeTarget: (target) => target.id }), log });
    t.after(() => manager.close());
    await replaceAtomically(file, 'b2 beta\n');
    assert.ok(await waitFor(() => manager.hasTarget('b2')));
    assert.deepEqual(info(), ['Loaded 1 targets', 'Added targets: b2', 'Removed targets: a1']);
});

test('a reload reports whole entries when the catalog asks: a new label is removed + added', async (t) => {
    const file = path.join(sandbox, 'list-d.txt');
    await writeFile(file, 'a1 alpha\nb2 beta\n');
    const { log, info } = recordingLog();
    const manager = TargetManager.create({ filePath: file, catalog: fakeCatalog({ listChangesBy: 'entry' }), log });
    t.after(() => manager.close());
    await replaceAtomically(file, 'a1 alpha_renamed\nb2 beta\n');
    assert.ok(await waitFor(() => manager.getTargets()[0]?.label === 'alpha_renamed'));
    assert.deepEqual(info(), ['Loaded 2 targets', 'Added targets: alpha_renamed (a1)', 'Removed targets: alpha (a1)']);
});

// ---- the sites file -------------------------------------------------------------

function capture(providerName) {
    return { pollIntervalMs: 1_000, mediaFormat: 'ts', provider: { providerName }, lookup: async () => null };
}
const catalog = fakeCatalog();
const modules = {
    good: { plugin: { id: 'good', label: 'Good', sdkVersion: SDK_VERSION, create: (ctx) => ({ capture: capture(ctx.siteId), catalog }) } },
    misnamed: { plugin: { id: 'misnamed', label: 'Misnamed', sdkVersion: SDK_VERSION, create: () => ({ capture: capture('other'), catalog }) } },
    uncataloged: { plugin: { id: 'uncataloged', label: 'Uncataloged', sdkVersion: SDK_VERSION, create: (ctx) => ({ capture: capture(ctx.siteId) }) } },
    unlabeled: { plugin: { id: 'unlabeled', sdkVersion: SDK_VERSION, create: (ctx) => ({ capture: capture(ctx.siteId), catalog }) } },
    destination: { plugin: { id: 'destination', label: 'Uploads', sdkVersion: SDK_VERSION, create: () => ({}) } },
};
const importPlugin = async (name) => modules[name];

async function sitesFile(name, sites) {
    const file = path.join(sandbox, name);
    await writeFile(file, typeof sites === 'string' ? sites : JSON.stringify({ sites }));
    return file;
}

test('the sites file defaults to <services data root>/sites.json and VIDEO_SITES_FILE overrides it', (t) => {
    const saved = process.env.VIDEO_SITES_FILE;
    t.after(() => { if (saved === undefined) delete process.env.VIDEO_SITES_FILE; else process.env.VIDEO_SITES_FILE = saved; });
    delete process.env.VIDEO_SITES_FILE;
    assert.equal(sitesFilePath(), path.join(sandbox, 'data', 'sites.json'));
    process.env.VIDEO_SITES_FILE = '/etc/elsewhere/sites.json';
    assert.equal(sitesFilePath(), '/etc/elsewhere/sites.json');
});

test("capture sites load with their plug-in's label, their list path and an init step", async () => {
    const file = await sitesFile('sites-ok.json', [
        { id: 'live-a', plugin: 'good' },
        { id: 'live-b', plugin: 'good' },
        { id: 'off', plugin: 'good', enabled: false },
        { id: 'uploads', plugin: 'destination' },
    ]);
    const sites = await loadCaptureSites(file, importPlugin);
    assert.deepEqual(sites.map(({ id, label, downloadList }) => ({ id, label, downloadList })), [
        { id: 'live-a', label: 'Good', downloadList: path.join(sandbox, 'data', 'download-lists', 'live-a.txt') },
        { id: 'live-b', label: 'Good', downloadList: path.join(sandbox, 'data', 'download-lists', 'live-b.txt') },
    ]);
    await sites[0].init();
    await sites[0].close();
    assert.equal(sites[0].capture.provider.providerName, 'live-a');
    assert.equal(sites[0].catalog, catalog);
});

test('the plug-in context names the site, its list and its own state directory', async () => {
    const seen = [];
    const inits = [];
    const spy = { plugin: { id: 'spy', label: 'Spy', sdkVersion: SDK_VERSION, create: (ctx) => {
        seen.push(ctx);
        return { capture: capture(ctx.siteId), catalog, init: () => { inits.push(ctx.siteId); } };
    } } };
    const file = await sitesFile('sites-spy.json', [{ id: 'live-c', plugin: 'spy', config: { host: 'h' } }]);
    const [site] = await loadCaptureSites(file, async () => spy);
    assert.deepEqual(inits, [], 'init waits for the host');
    await site.init();
    assert.deepEqual(inits, ['live-c']);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].siteId, 'live-c');
    assert.deepEqual(seen[0].config, { host: 'h' });
    // Changed on purpose: two paths for sites with browser sign-ins were added (home-relative,
    // named after the site); the two before are unchanged.
    const home = path.join(os.homedir(), '.local');
    assert.deepEqual(seen[0].paths, {
        stateDir: path.join(sandbox, 'data', 'site-state', 'live-c'),
        downloadList: path.join(sandbox, 'data', 'download-lists', 'live-c.txt'),
        browserProfiles: path.join(home, 'share', 'video-services', 'live-c-browser-profiles'),
        loginState: path.join(home, 'state', 'video-services', 'live-c-login'),
    });
    assert.equal(typeof seen[0].store.write, 'function');
    assert.equal(typeof seen[0].credentials.read, 'function');
    assert.equal(typeof seen[0].clock.now(), 'number');
});

test('a missing, invalid or unusable sites file is fatal', async () => {
    await assert.rejects(loadCaptureSites(path.join(sandbox, 'absent.json'), importPlugin), /ENOENT/);
    await assert.rejects(loadCaptureSites(await sitesFile('sites-bad.json', '{"sites": ['), importPlugin), /invalid JSON/);
    await assert.rejects(loadCaptureSites(await sitesFile('sites-none.json', []), importPlugin), /no site with live capture/);
    await assert.rejects(loadCaptureSites(await sitesFile('sites-dest.json', [{ id: 'u', plugin: 'destination' }]), importPlugin),
        /no site with live capture/);
    await assert.rejects(loadCaptureSites(await sitesFile('sites-misnamed.json', [{ id: 'live-a', plugin: 'misnamed' }]), importPlugin),
        /capture provider is named "other"/);
    await assert.rejects(loadCaptureSites(await sitesFile('sites-uncataloged.json', [{ id: 'live-a', plugin: 'uncataloged' }]), importPlugin),
        /needs a catalog/);
    await assert.rejects(loadCaptureSites(await sitesFile('sites-unlabeled.json', [{ id: 'live-a', plugin: 'unlabeled' }]), importPlugin),
        /has no label/);
});
