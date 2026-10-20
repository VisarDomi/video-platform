import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PipelineDatabase } from '../dist/db/pipelineDatabase.js';

async function legacy(t, fail = false) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'retired-destination-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'ledger.sqlite');
    const database = new PipelineDatabase(file);
    for (const [id, seconds] of [['old', 600], ['short', 60], ['kept', 600], ['banned', 600], ['retry', 600]]) {
        database.discover({ provider: 'tango', sourceKind: 'edited', sourcePath: path.join(root, id),
            playlistPath: path.join(root, id, 'playlist.m3u8'), sourceFingerprint: 'original-'+id, durationSeconds: seconds });
    }
    database.setCampaignState('paused'); database.close();
    const raw = new DatabaseSync(file);
    const add = (id, provider, remote, status = 'accepted') => {
        raw.prepare(`INSERT INTO upload_attempts (id,recording_id,provider,status,phase,remote_id,remote_url,started_at,completed_at)
            VALUES (?,?,?,?,'metadata_submitting',?,?,?,?)`).run(id+'-'+provider, id, provider, status, remote,
                remote ? provider==='porntrex' ? `https://www.porntrex.com/video/${remote}/fixture` : `https://www.xvideos.com/video.fixture/${remote}` : null,
                '2026-10-01T00:00:00Z','2026-10-01T00:01:00Z');
        if (status === 'accepted') raw.prepare('INSERT INTO remote_uploads VALUES (?,?,?,?,?,?)')
            .run(id,'full',id+'-'+provider,remote,provider==='porntrex' ? `https://www.porntrex.com/video/${remote}/fixture` : `https://www.xvideos.com/video.fixture/${remote}`,'2026-10-02T00:00:00Z');
    };
    for (const id of ['old','short','banned','retry']) { add(id,'xvideos','100'+id); raw.prepare("UPDATE recordings SET state='cleanup_eligible' WHERE id=?").run(id); }
    add('kept','porntrex','200'); raw.prepare("UPDATE recordings SET state='xvideos_verified' WHERE id='kept'").run();
    add('retry','porntrex',null,'failed');
    raw.prepare("INSERT INTO provider_removals VALUES ('banned','porntrex','300','removed','2026-10-03T00:00:00Z')").run();
    raw.prepare("INSERT INTO bandwidth_events (recording_id,attempt_id,provider,calendar_month,transmitted_bytes,created_at) VALUES ('old','old-xvideos','xvideos','2026-10',500,'2026-10-01T00:00:00Z')").run();
    for (const table of ['campaign_control','provider_removals']) {
        const sql = raw.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table).sql
            .replace("DEFAULT 'porntrex'", "DEFAULT 'xvideos'")
            .replace("CHECK (upload_provider = 'porntrex')", "CHECK (upload_provider IN ('xvideos', 'porntrex'))")
            .replace("CHECK (provider = 'porntrex')", "CHECK (provider IN ('xvideos', 'porntrex'))");
        const rows = raw.prepare(`SELECT * FROM ${table}`).all();
        raw.exec(`DROP TABLE ${table}`); raw.exec(sql);
        for (const row of rows) raw.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
    }
    raw.exec("UPDATE schema_version SET version=13; UPDATE campaign_control SET upload_provider='xvideos'");
    if (fail) raw.exec("CREATE TRIGGER reject_retirement BEFORE DELETE ON upload_attempts BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    raw.close();
    return { file };
}

test('schema 14 retires old copies, requeues their sources, preserves Porntrex proofs and the indefinite pause', async t => {
    const { file } = await legacy(t);
    const database = new PipelineDatabase(file); t.after(()=>database.close());
    assert.equal(database.get('old').state,'server_ready');
    assert.equal(database.get('short').state,'short_waiting');
    assert.equal(database.get('retry').state,'server_ready','a previous failed Porntrex attempt is not a backup');
    assert.equal(database.get('kept').state,'upload_verified');
    assert.equal(database.get('banned').state,'blocked');
    assert.equal(database.getUploadIdentity('old'),null);
    assert.equal(database.getUploadIdentity('kept').remoteId,'200');
    assert.equal(database.getCampaignControl().state,'paused');
    assert.equal(database.getCampaignControl().resumeAt,null);
    assert.equal(database.getActiveUploadProvider(),'porntrex');
    assert.equal(database.uploadUsage('2026-10').spent,500,'retired bandwidth remains charged');
    const raw = new DatabaseSync(file); t.after(()=>raw.close());
    const audit = JSON.parse(raw.prepare('SELECT evidence_json FROM retired_destination_audit').get().evidence_json);
    assert.equal(audit.attempts.length,4);
    assert.equal(audit.remote_uploads.length,4);
    assert.equal(raw.prepare('SELECT count(*) n FROM remote_uploads').get().n,1);
    assert.equal(raw.prepare('SELECT version FROM schema_version').get().version,14);
    assert.throws(()=>database.setActiveUploadProvider('xvideos'),/provider/);
    assert.throws(()=>raw.exec("UPDATE campaign_control SET upload_provider='xvideos'"),/CHECK/);
    const count = raw.prepare('SELECT count(*) n FROM state_events').get().n;
    const again = new PipelineDatabase(file); again.close();
    assert.equal(raw.prepare('SELECT count(*) n FROM state_events').get().n,count,'reopen is idempotent');
});

test('a failed retirement rolls back receipts, work states and schema version together', async t => {
    const { file } = await legacy(t,true);
    assert.throws(()=>new PipelineDatabase(file),/injected failure/);
    const raw = new DatabaseSync(file); t.after(()=>raw.close());
    assert.equal(raw.prepare('SELECT version FROM schema_version').get().version,13);
    assert.equal(raw.prepare('SELECT count(*) n FROM remote_uploads').get().n,5);
    assert.equal(raw.prepare("SELECT state FROM recordings WHERE id='old'").get().state,'cleanup_eligible');
});
