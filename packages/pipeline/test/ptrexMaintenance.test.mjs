import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PipelineDatabase } from '../dist/db/pipelineDatabase.js';
import { maintainPorntrexSession } from '../dist/commands/maintainPorntrexSession.js';

async function fixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ptrex-maintenance-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const config = { databasePath: path.join(root, 'pipeline.sqlite'), porntrexSessionPath: path.join(root, 'session.json'), networkUploadsEnabled: false };
    const db = new PipelineDatabase(config.databasePath); t.after(() => db.close());
    db.setCampaignState('paused');
    db.discover({ provider: 'tango', sourceKind: 'edited', sourcePath: path.join(root, 'recording'), playlistPath: path.join(root, 'recording/playlist.m3u8'), sourceFingerprint: 'original', durationSeconds: 200 });
    return { config, db };
}
const ok = { loggedIn: true, fingerprint: 'test-id', passwordLoginAt: null, note: 'upload form served' };

test('session maintenance continues with uploads disabled and preserves the manual pause and all work', async t => {
    const { config, db } = await fixture(t), before = db.getCampaignControl(), queueBefore = db.list(); let calls = 0;
    const result = await maintainPorntrexSession(config, new Date(), {
        check: async file => { assert.equal(file, config.porntrexSessionPath); calls++; return ok; }, notify: () => assert.fail('healthy session must not notify'),
    });
    assert.equal(calls, 1); assert.equal(result.disposition, 'logged_in');
    assert.deepEqual(db.getCampaignControl(), before);
    assert.deepEqual(db.list(), queueBefore);
    assert.equal(db.listProviderSessionEvents('porntrex').at(-1).loggedIn, true);
});

test('a live worker owns maintenance; stale heartbeat releases it to the independent job', async t => {
    const { config, db } = await fixture(t), now = new Date('2026-10-22T00:00:00Z'); let calls = 0;
    db.writeWorkerHeartbeat(now);
    const dependencies = { check: async () => { calls++; return ok; }, notify: () => {} };
    assert.equal((await maintainPorntrexSession(config, now, dependencies)).disposition, 'worker_active');
    assert.equal(calls, 0);
    assert.equal((await maintainPorntrexSession(config, new Date(now.getTime() + 91000), dependencies)).disposition, 'logged_in');
    assert.equal(calls, 1);
});

test('lost-session warnings are deduplicated, never log in and never resume upload intent', async t => {
    const { config, db } = await fixture(t), before = db.getCampaignControl(); let notices = 0;
    const dependencies = { check: async () => ({ ...ok, loggedIn: false, note: 'redirected to /' }), notify: () => notices++ };
    for (let i = 0; i < 2; i++) assert.equal((await maintainPorntrexSession(config, new Date(), dependencies)).disposition, 'logged_out');
    assert.equal(notices, 1); assert.deepEqual(db.getCampaignControl(), before);
    assert(db.listProviderSessionEvents('porntrex').every(e => e.kind === 'keepalive'));
});

test('an outage records an inconclusive check without declaring a logout or changing the campaign', async t => {
    const { config, db } = await fixture(t), before = db.getCampaignControl();
    const result = await maintainPorntrexSession(config, new Date(), { check: async () => { throw new Error('HTTP 503'); }, notify: () => assert.fail('outage is not logout') });
    assert.equal(result.disposition, 'unavailable');
    assert.deepEqual(db.getCampaignControl(), before);
    assert.equal(db.listProviderSessionEvents('porntrex').at(-1).kind, 'keepalive_error');
});
