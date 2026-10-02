import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { PipelineDatabase } from "../dist/db/pipelineDatabase.js";
import { pipelineConfig } from "../dist/config.js";
import { reconcileDueUploads } from "../dist/commands/reconcileUploads.js";
import { ChromiumXvideosUploader } from "../dist/upload/chromiumXvideosUploader.js";
import { composeUploadMetadata, uploadLookupIdentity } from "../dist/metadata/composeUploadMetadata.js";
import { limitedVisibilityWarning } from "../dist/upload/providerWarnings.js";
import { syncPublishedArtifact } from "../dist/stages/durableArtifact.js";

const start = new Date("2026-09-20T08:23:10.171Z");
const day = n => new Date(start.getTime() + n * 86400000);
async function fixture(t, { pending = true, unresolved = false } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-recovery-policy-"));
    const config = { ...pipelineConfig, databasePath: path.join(root, "pipeline.sqlite"), networkUploadsEnabled: true, cleanupEnabled: false };
    const db = new PipelineDatabase(config.databasePath);
    t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
    const r = db.discover({ provider: "tango", sourceKind: "edited", sourcePath: path.join(root, "2025-11-22 125658 example"),
        playlistPath: path.join(root, "playlist.m3u8"), sourceFingerprint: "fingerprint", durationSeconds: 600 });
    db.transition(r.id, "server_ready", "remuxed");
    db.saveArtifact(r.id, { path: path.join(root, "artifact.mp4"), sizeBytes: 100, sha256: "a".repeat(64), validatedAt: start.toISOString() });
    db.saveDescription(r.id, { artifactSha256: "a".repeat(64), promptVersion: "test", fps: 1,
        output: { title: "Natural model title", description: "Saved description" }, evidencePath: path.join(root, "evidence.json") });
    db.saveProvenance(r.id, { observedIdentifier: "example", status: unresolved ? "review_required" : "resolved",
        streamerId: unresolved ? null : "123", alias: unresolved ? null : "example",
        streamerUrl: unresolved ? null : "https://tango.me/123", aliasUrl: null,
        reason: unresolved ? "identifier_not_resolved_by_server" : null, updatedAt: start.toISOString() });
    const metadata = composeUploadMetadata(r, db.getDescription(r.id), db.getProvenance(r.id));
    db.saveUploadMetadata(r.id, metadata);
    if (!pending) return { db, config, root, r, metadata };
    const reservation = db.reserveUpload(r.id, 120, start);
    const attempt = db.beginUpload(r.id, reservation, start);
    db.updateUploadProgress(attempt, "metadata_submitting", 100, start);
    db.finishUploadAttempt(attempt, { status: "uncertain", transmittedBytes: 100,
        confirmation: { confirmAfter: day(1) } }, start);
    return { db, config, root, r, metadata, attempt };
}
const browser = lookup => ({ withAuthenticatedPage: async run => run({}), lookupUpload: lookup,
    probeUploadStatus: async () => ({ outcome: "online", remoteUrl: "https://www.xvideos.com/video.example/test",
        renditions: [{ width: 1080, height: 1920 }] }) });

test("unresolved reference uploads as TODO LATER without inventing account data or changing title", async t => {
    const { db, r, metadata } = await fixture(t, { unresolved: true, pending: false });
    assert.equal(metadata.title, `Natural model title [${r.id}]`);
    assert.match(metadata.description, /Source: TODO LATER$/);
    assert.equal(db.getProvenance(r.id).streamerId, null);
    assert.equal(db.get(r.id).state, "metadata_ready");
});

test("production filename recovery attaches existing ID and atomically verifies without transfer", async t => {
    const { db, config, r } = await fixture(t);
    const spent = db.uploadUsage("2026-09").spent;
    await reconcileDueUploads(config, day(1), browser(async (_, identity) => {
        assert.equal(identity, r.id);
        return { kind: "found", remoteId: "91957324", remoteUrl: "https://www.xvideos.com/video.example/test" };
    }));
    assert.equal(db.get(r.id).state, "xvideos_verified");
    assert.equal(db.getUploadIdentity(r.id).remoteId, "91957324");
    assert.equal(db.uploadUsage("2026-09").spent, spent);
});

test("changing active destination still verifies historical attempts on their pinned provider", async t => {
    const { db, config, r } = await fixture(t);
    const providers = [];
    await reconcileDueUploads({ ...config, uploadProvider: "porntrex" }, day(1), undefined, async (_config, provider) => {
        providers.push(provider);
        return browser(async () => ({ kind: "found", remoteId: "12345", remoteUrl: "https://www.xvideos.com/video.example/test" }));
    });
    assert.deepEqual(providers, ["xvideos"]);
    assert.equal(db.get(r.id).state, "xvideos_verified");
});

test("clean absence waits seven days across reopen, then requeues once with a fresh weekly gate", async t => {
    const { db, config, r, attempt } = await fixture(t);
    const absent = browser(async () => ({ kind: "absent" }));
    await reconcileDueUploads(config, day(1), absent);
    assert.equal(db.get(r.id).state, "xvideos_uncertain");
    assert.equal(db.latestUploadDiagnostics(r.id).lookup_state, "absent");
    const reopened = new PipelineDatabase(config.databasePath);
    assert.equal(reopened.canAttemptUpload(r.id, day(6)), false);
    assert.equal(reopened.latestUploadDiagnostics(r.id).retry_not_before, day(7).toISOString());
    reopened.close();
    await reconcileDueUploads(config, day(7), absent);
    assert.equal(db.get(r.id).state, "metadata_ready");
    assert.equal(db.latestUploadDiagnostics(r.id).confirmation_status, "absent");
    assert.equal(db.recordUploadLookup(attempt, "absent", day(8)), false);
    const reservation = db.reserveUpload(r.id, 120, day(7));
    const next = db.beginUpload(r.id, reservation, day(7));
    db.updateUploadProgress(next, "file_uploading", 0, day(7));
    db.recoverInterruptedUploads(day(8));
    assert.equal(db.canAttemptUpload(r.id, day(13)), false);
    assert.equal(db.canAttemptUpload(r.id, day(14)), true);
    assert.equal(db.uploadUsage("2026-09").spent, 100);
});

test("login/search errors and ambiguous matches never become absence even after weeks", async t => {
    const { db, config, r } = await fixture(t);
    await reconcileDueUploads(config, day(8), browser(async () => { throw Error("search HTTP 502"); }));
    assert.equal(db.get(r.id).state, "xvideos_uncertain");
    assert.equal(db.latestUploadDiagnostics(r.id).lookup_state, null);
    await reconcileDueUploads(config, day(9), browser(async () => ({ kind: "ambiguous" })));
    assert.equal(db.get(r.id).state, "xvideos_uncertain");
    assert.equal(db.latestUploadDiagnostics(r.id).lookup_state, "ambiguous");
});

test("limited visibility survives evidence rotation/restart and never authorizes reupload", async t => {
    const { db, config, r, attempt } = await fixture(t);
    db.recordUploadEvidence(attempt, { text: "Sorry, 'waisted' is not allowed here." });
    for (let i = 0; i < 30; i++) db.recordUploadEvidence(attempt, { stage: "later_check" });
    const reopened = new PipelineDatabase(config.databasePath);
    assert.match(reopened.latestUploadDiagnostics(r.id).limited_visibility, /waisted/);
    reopened.close();
    await reconcileDueUploads(config, day(30), browser(async () => ({ kind: "absent" })));
    assert.equal(db.get(r.id).state, "xvideos_uncertain");
    await reconcileDueUploads(config, day(31), browser(async () => ({ kind: "found", remoteId: "123", remoteUrl: "https://www.xvideos.com/video.example/test" })));
    assert.equal(db.get(r.id).state, "xvideos_verified");
    assert.match(db.latestUploadDiagnostics(r.id).limited_visibility, /waisted/);
    assert.equal(limitedVisibilityWarning("You have 1 video(s) currently blocked and requesting an edit"), null);
});

test("verification failure rolls back acceptance, confirmation and state as one transaction", async t => {
    const { db, config, r, attempt } = await fixture(t);
    const raw = new DatabaseSync(config.databasePath);
    raw.exec("CREATE TRIGGER fail_verification BEFORE INSERT ON remote_uploads BEGIN SELECT RAISE(ABORT, 'injected crash boundary'); END");
    assert.throws(() => db.verifyUpload(attempt, "123", "https://www.xvideos.com/video.example", day(1)), /injected/);
    assert.equal(db.get(r.id).state, "xvideos_uncertain");
    assert.equal(db.latestUploadDiagnostics(r.id).status, "uncertain");
    assert.equal(db.latestUploadDiagnostics(r.id).confirmation_status, "pending");
    raw.exec("DROP TRIGGER fail_verification"); raw.close();
    db.verifyUpload(attempt, "123", "https://www.xvideos.com/video.example", day(1));
    assert.equal(db.get(r.id).state, "xvideos_verified");
});

test("legacy accepted-but-unverified crash window is restored and verified without uploading", async t => {
    const { db, config, r, attempt } = await fixture(t);
    db.reconcileUncertain(attempt, "123", "https://www.xvideos.com/video.example", day(1));
    assert.equal(db.get(r.id).state, "xvideos_uploaded");
    assert.equal(db.recoverAcceptedVerifications(day(2)), 1);
    assert.equal(db.recoverAcceptedVerifications(day(2)), 0);
    await reconcileDueUploads(config, day(2), browser(async () => { throw Error("known ID must not search"); }));
    assert.equal(db.get(r.id).state, "xvideos_verified");
});

test("reservation-only crash releases quota and returns to metadata without a weekly penalty", async t => {
    const { db, r } = await fixture(t, { pending: false });
    db.reserveUpload(r.id, 120, start);
    db.recoverInterruptedUploads(day(1));
    assert.equal(db.get(r.id).state, "metadata_ready");
    assert.deepEqual(db.uploadUsage("2026-09"), { spent: 0, reserved: 0 });
    assert(db.canAttemptUpload(r.id, day(1)));
});

test("SIGKILL after durable transfer/ID evidence preserves identity, quota and retry deadline", async t => {
    const { db, config, r } = await fixture(t, { pending: false });
    const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", `
        import { PipelineDatabase } from ${JSON.stringify(new URL('../dist/db/pipelineDatabase.js', import.meta.url).href)};
        const db = new PipelineDatabase(process.argv[1]); const now = new Date(process.argv[3]);
        const a = db.beginUpload(process.argv[2], db.reserveUpload(process.argv[2],120,now),now);
        db.updateUploadProgress(a,'file_uploading',100,now);
        db.recordUploadEvidence(a,{stage:'remote_identity_captured',remoteId:'456'},now);
        process.stdout.write('committed\\n'); setInterval(()=>{},1000);
    `, config.databasePath, r.id, start.toISOString()], { stdio: ['ignore','pipe','pipe'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const exit = once(child,'exit');
    await new Promise((resolve,reject) => { child.stdout.once('data',resolve); child.once('error',reject); child.once('exit',code=>reject(Error(`early exit ${code}`))); });
    child.kill('SIGKILL'); await exit;
    db.recoverInterruptedUploads(day(1));
    db.recoverInterruptedUploads(day(1));
    assert.equal(db.get(r.id).state,'xvideos_uncertain');
    assert.equal(db.getUploadIdentity(r.id).remoteId,'456');
    assert.match(db.latestUploadDiagnostics(r.id).error,/file_uploading/);
    assert.equal(db.latestUploadDiagnostics(r.id).retry_not_before,day(7).toISOString());
    assert.deepEqual(db.uploadUsage('2026-09'),{spent:100,reserved:0});
});

test("exact suffix lookup distinguishes absent, ambiguous, wrong generation and same-name substrings", async () => {
    const b = new ChromiumXvideosUploader({});
    b.findEntries = async () => [{remoteId:'1',remoteUrl:'url',title:'Title [example]'}];
    assert.equal((await b.lookupUpload({},'example')).kind,'found');
    assert.equal((await b.lookupUpload({},'example | production-v6 | full')).kind,'ambiguous');
    b.findEntries = async () => [{remoteId:'1',title:'Title [example]'}, {remoteId:'2',title:'Another [example]'}];
    assert.equal((await b.lookupUpload({},'example')).kind,'ambiguous');
    b.findEntries = async () => [];
    assert.equal((await b.lookupUpload({},'example')).kind,'absent');
    assert.equal(uploadLookupIdentity({sourcePath:'/recordings/example'},'full','Title [example]'),'example');
    assert.equal(uploadLookupIdentity({sourcePath:'/recordings/example'},'nonmax1080p','Title [example]'),null);
});

test("artifact durability flush preserves completed bytes and rejects missing outputs", async t => {
    const { root } = await fixture(t, { pending:false });
    const file = path.join(root,'finished.mp4'); await writeFile(file,'complete bytes');
    await syncPublishedArtifact(file); assert.equal(await readFile(file,'utf8'),'complete bytes');
    await assert.rejects(()=>syncPublishedArtifact(path.join(root,'missing.mp4')),/ENOENT/);
});

test("provider search only accepts authenticated complete results or the observed explicit empty state", async () => {
    const b = new ChromiumXvideosUploader({});
    function page({ ok=true, auth=true, body='Your filters return no video. Click here to reset them.', rows=[], paginated=false } = {}) {
        let url;
        return { goto: async target => { url=target; return {ok:()=>ok}; }, url:()=>url,
            getByText:()=>({count:async()=>auth?1:0}),
            locator:selector => selector.startsWith('[id^=') ? {evaluateAll:async()=>rows}
                : selector==='body' ? {innerText:async()=>body} : {count:async()=>paginated?1:0} };
    }
    assert.deepEqual(await b.findEntries(page(),'filename'),[]);
    await assert.rejects(()=>b.findEntries(page({ok:false}),'filename'),/failed or redirected/);
    await assert.rejects(()=>b.findEntries(page({auth:false}),'filename'),/not authenticated/);
    await assert.rejects(()=>b.findEntries(page({body:'Loading...'}),'filename'),/no recognized empty/);
    await assert.rejects(()=>b.findEntries(page({paginated:true}),'filename'),/Paginated/);
    await assert.rejects(()=>b.findEntries(page({rows:[{containerId:'listing-video-123',title:'Processing [filename]',remoteUrl:''}]}),'filename'),/Incomplete/);
    assert.equal((await b.findEntries(page({rows:[{containerId:'listing-video-123',title:'Title [filename]',remoteUrl:'/video.test'}]}),'filename'))[0].remoteId,'123');
});

test("existing reference-review rows are released once without losing descriptions or falsely resolving identity", async t => {
    const { db, config, r } = await fixture(t,{pending:false,unresolved:true});
    const raw=new DatabaseSync(config.databasePath);
    raw.prepare("UPDATE recordings SET state='provenance_review_required' WHERE id=?").run(r.id);
    raw.prepare('DELETE FROM upload_metadata WHERE recording_id=?').run(r.id);raw.close();
    assert.equal(db.releasePlaceholderReferences(),1);
    assert.equal(db.releasePlaceholderReferences(),0);
    assert.equal(db.get(r.id).state,'described');
    assert.equal(db.getDescription(r.id).output.description,'Saved description');
    assert.equal(db.getProvenance(r.id).status,'review_required');
});
