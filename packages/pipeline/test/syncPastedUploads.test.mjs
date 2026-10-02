import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { parseListing, planSync, applySync } from '../scripts/sync-pasted-uploads.mjs';
import { PipelineDatabase } from '../dist/db/pipelineDatabase.js';
import { pipelineConfig } from '../dist/config.js';
import { inspectFinalizedRecording } from '../dist/discovery/inspectRecording.js';
import { reconcileDueUploads } from '../dist/commands/reconcileUploads.js';
import { guardUploadIdentity } from '../dist/commands/uploadIdentityGuard.js';

const id = '2026-01-01 123456 sample';
const listing = (remoteId, title = `Example [${id}]`) =>
    ` [${title.replaceAll(']', '\\]')}](https://www.xvideos.com/video.example${remoteId}/title)\n`
    + `Uploaded yesterday\n[Edit](https://www.xvideos.com/account/uploads/${remoteId}/edit)\n`;

test('listing parser uses exact filename suffix and edit ID, including old full diagnostic titles', () => {
    const entries = parseListing(listing('123') + listing('456', `Other words [${id} | production-v4 | full]`), 'input.txt');
    assert.deepEqual(entries.map(e => [e.recordingId, e.remoteId]), [[id, '123'], [id, '456']]);
    assert.throws(() => parseListing(listing('123', `Other [${id} | production-v4 | nonmax1080p]`), 'input'), /partial/);
    assert.throws(() => parseListing(listing('123', 'Example [2026-01-01 123456 ../../escape]'), 'input'), /Unsafe/);
    assert.throws(() => parseListing(listing('123') + '[Edit](https://www.xvideos.com/account/uploads/456/edit)', 'input'), /Multiple/);
});

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-listing-sync-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const sourceRoot = path.join(root, 'sources');
    const sourcePath = path.join(sourceRoot, id);
    await fs.mkdir(sourcePath, { recursive: true });
    const playlist = '#EXTM3U\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n';
    await fs.writeFile(path.join(sourcePath, 'playlist.m3u8'), playlist);
    await fs.writeFile(path.join(sourcePath, 'segment.ts'), 'source fixture');
    const { recording: source } = await inspectFinalizedRecording(sourcePath, 'sc', 'edited');
    const config = { ...pipelineConfig, databasePath: path.join(root, 'pipeline.sqlite'),
        finalizationDatabasePath: path.join(root, 'finalization.sqlite'), artifactsRoot: path.join(root, 'artifacts'),
        stagingRoot: path.join(root, 'artifacts', 'production-v6'),
        discoveryRoots: [{ path: sourceRoot, provider: 'sc', sourceKind: 'edited' }],
        networkUploadsEnabled: true, cleanupEnabled: false, comparisonTrialOnly: false };
    new PipelineDatabase(config.databasePath).close();
    const final = new DatabaseSync(config.finalizationDatabasePath);
    final.exec('CREATE TABLE integrity_checkpoints(recording_path TEXT, playlist_fingerprint TEXT, report_json TEXT, updated_at TEXT)');
    final.prepare('INSERT INTO integrity_checkpoints VALUES(?,?,?,?)').run(sourcePath,
        createHash('sha256').update(playlist).digest('hex'), JSON.stringify({ version: 2, status: 'ready' }), new Date().toISOString());
    final.close();
    for (const [version, remoteId] of [['production-v3', '123'], ['production-v4', '456']]) {
        const archivePath = path.join(root, 'history', version, 'snapshot.sqlite');
        const old = new PipelineDatabase(archivePath);
        const artifactPath = path.join(config.artifactsRoot, version, `${id}.mp4`);
        await fs.mkdir(path.dirname(artifactPath), { recursive: true });
        const bytes = Buffer.from(`validated artifact ${version}`);
        await fs.writeFile(artifactPath, bytes);
        old.discover(source);
        old.saveRemuxOutput(id, artifactPath);
        old.saveArtifact(id, { path: artifactPath, sizeBytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'), validatedAt: new Date().toISOString() });
        old.close();
        const raw = new DatabaseSync(archivePath);
        raw.prepare('UPDATE production_version SET version=?').run(version);
        raw.prepare(`INSERT INTO upload_attempts(id,recording_id,provider,status,remote_id,remote_url,started_at)
            VALUES(?,?,'sc','accepted',?,?,'2026-01-02T00:00:00Z')`).run(remoteId, id, remoteId, `https://www.xvideos.com/video.example${remoteId}/title`);
        if (version === 'production-v4') raw.prepare(`INSERT INTO remote_uploads(recording_id,attempt_id,remote_id,remote_url,verified_at)
            VALUES(?,?,?,?,'2026-01-03T00:00:00Z')`).run(id, remoteId, remoteId, `https://www.xvideos.com/video.example${remoteId}/title`);
        raw.close();
    }
    const input = path.join(root, 'listing.txt');
    await fs.writeFile(input, listing('123') + listing('456'));
    return { root, config, input };
}

test('offline import prefers verified replacement, prevents re-upload, adds no bandwidth and supports normal verification', async t => {
    const { config, input } = await fixture(t);
    const plan = await planSync([input], config);
    assert.equal(plan.imports.length, 1);
    assert.equal(plan.imports[0].remoteId, '456');
    assert.deepEqual(plan.replacements[0].alternatives, ['123']);
    const result = await applySync(plan, config);
    assert.equal(result.uploadBytes, 0);
    assert.equal(result.playbackVerifiedByImport, false);
    const db = new PipelineDatabase(config.databasePath);
    try {
        assert.equal(db.get(id).state, 'xvideos_uncertain');
        assert.equal(db.getUploadIdentity(id).remoteId, '456');
        assert.equal(db.getUploadIdentity(id).verified, false);
        assert.equal((await guardUploadIdentity(db, db.get(id), config)).kind, 'unverified_refused');
        assert.match(db.getArtifact(id).path, /existing-456\.mp4$/);
        const again = await planSync([input], config);
        assert.equal(again.imports.length, 0);
        assert.equal(again.alreadyLinked.length, 1);
        const raw = new DatabaseSync(config.databasePath, { readOnly: true });
        for (const table of ['bandwidth_events', 'upload_reservations']) assert.equal(raw.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
        assert.equal(raw.prepare('SELECT transmitted_bytes FROM upload_attempts').get().transmitted_bytes, 0);
        raw.close();
        await reconcileDueUploads(config, new Date(Date.now() + 1000), {
            withAuthenticatedPage: async run => run({}),
            probeUploadStatus: async (_, remoteId) => {
                assert.equal(remoteId, '456');
                return { outcome: 'online', remoteUrl: 'https://www.xvideos.com/video.example456/title',
                    renditions: [{ width: 1920, height: 1080, label: '1080p' }] };
            },
        });
        assert.equal(db.get(id).state, 'xvideos_verified');
        assert.equal(db.getUploadIdentity(id).verified, true);
    } finally { db.close(); }
});

test('changed source and corrupt artifact cannot be imported from archive metadata', async t => {
    const { config, input } = await fixture(t);
    const plan = await planSync([input], config);
    await fs.writeFile(plan.imports[0].archive.artifact_path, 'corrupted bytes');
    await assert.rejects(applySync(plan, config), /checksum/);
    const db = new PipelineDatabase(config.databasePath);
    assert.equal(db.get(id), null);
    db.close();
    await fs.writeFile(path.join(config.discoveryRoots[0].path, id, 'segment.ts'), 'changed source with a different size');
    const changed = await planSync([input], config);
    assert.equal(changed.imports.length, 0);
    assert.equal(changed.conflicts.length, 1);
});
