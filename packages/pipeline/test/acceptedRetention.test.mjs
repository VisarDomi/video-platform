import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PipelineDatabase } from '../dist/db/pipelineDatabase.js';
import { UploadCoordinator } from '../dist/upload/uploadCoordinator.js';
import { pipelineConfig } from '../dist/config.js';
import { reconcileDueUploads } from '../dist/commands/reconcileUploads.js';
import { sweepMissingRecordings } from '../dist/commands/sweep.js';
import { inspectFinalizedRecording } from '../dist/discovery/inspectRecording.js';
const start = new Date('2026-10-21T12:00:00Z');
const day = n => new Date(+start + n * 86400000);
async function fixture(t) {
 const root = await mkdtemp(path.join(os.tmpdir(), 'accepted-retention-'));
 const source = path.join(root, '2026-10-01 120000 example');
 const stagingRoot = path.join(root, 'artifacts');
 await mkdir(source); await mkdir(stagingRoot);
 await writeFile(path.join(source, 'playlist.m3u8'), '#EXTM3U\n#EXTINF:600,\n0.ts\n#EXT-X-ENDLIST\n');
 await writeFile(path.join(source, '0.ts'), 'original media');
 const input = (await inspectFinalizedRecording(source, 'sc', 'edited')).recording;
 const config = {...pipelineConfig, databasePath: path.join(root,'pipeline.sqlite'), stagingRoot,
 artifactsRoot: stagingRoot, cleanupEnabled:true, networkUploadsEnabled:true};
 const db = new PipelineDatabase(config.databasePath);
 const r = db.discover(input, start);
 db.transition(r.id, 'server_ready', 'remuxed', 'fixture', start);
 const artifact = {path:path.join(stagingRoot,'conversion.mp4'),sizeBytes:10,
 sha256:createHash('sha256').update('conversion').digest('hex'), validatedAt:start.toISOString()};
 await writeFile(artifact.path,'conversion');
 db.saveArtifact(r.id,artifact,start);
 db.saveDescription(r.id,{artifactSha256:artifact.sha256,promptVersion:'test',fps:1,output:{title:'Title',description:'Description'},evidencePath:path.join(root,'evidence.json')},start);
 db.saveProvenance(r.id,{observedIdentifier:'example',status:'resolved',streamerId:'42',alias:'example',streamerUrl:'https://stripchat.com/example',aliasUrl:null,reason:null,updatedAt:start.toISOString()});
 db.saveUploadMetadata(r.id,{title:`Title [${r.id}]`,description:'Description',tags:['live']},start);
 const raw = new DatabaseSync(config.databasePath);
 t.after(async()=>{raw.close();db.close();await rm(root,{recursive:true,force:true});});
 return {root,db,r,artifact,config,raw,source};
}
async function submit(f, id='123') {
 const reservation = f.db.reserveUpload(f.r.id,20,start);
 await new UploadCoordinator(f.db,{upload:async request=>{
  await request.onProgress('file_uploaded',10);
  await request.onEvidence({stage:'file_transfer_complete',bytesAcknowledged:10,totalBytes:10});
  await request.onProgress('metadata_submitting',10);
  return {kind:'uploaded',receipt:{transmittedBytes:10,submittedVideoId:id,metadataSubmittedAt:start.toISOString()}};
 }}).uploadAdmitted(f.r.id,reservation,{recordingId:f.r.id,artifactPath:f.artifact.path,sizeBytes:10,
 title:'Title',description:'Description',tags:[],visibility:'public'},start);
}
const browser = probe => ({withAuthenticatedPage:async run=>run({}),probeUploadStatus:probe});

test('acceptance starts a seven-day window; cleanup needs durable matching bytes and survives reopen',async t=>{
 const f=await fixture(t);await submit(f);
 assert.deepEqual(f.db.dueUploadConfirmations(day(6)),[]);
 assert.equal(f.db.dueUploadConfirmations(day(7)).length,1);
 const { cleanupAcceptedConversions } = await import('../dist/commands/acceptedConversions.js');
 await cleanupAcceptedConversions(f.db,f.config,start);
 await assert.rejects(access(f.artifact.path),{code:'ENOENT'});
 assert.equal(await readFile(path.join(f.source,'0.ts'),'utf8'),'original media');
 const reopened=new PipelineDatabase(f.config.databasePath);
 await cleanupAcceptedConversions(reopened,f.config,day(1));reopened.close();
 assert(f.db.getArtifact(f.r.id));
 assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM upload_attempts').get().n,1);
 assert(f.raw.prepare('SELECT deleted_at FROM upload_artifact_receipts').get().deleted_at);
});

test('never-verified missing copy rebuilds after seven days without erasing its ID or billing',async t=>{
 const f=await fixture(t);await submit(f);
 let calls=0;
 const probe=browser(async()=>{calls++;return {outcome:'missing',reason:'confirmed absent',remoteUrl:null};});
 await reconcileDueUploads(f.config,day(6),probe);assert.equal(calls,0);
 await reconcileDueUploads(f.config,day(7),probe);
 assert.equal(f.db.get(f.r.id).state,'server_ready');
 assert.equal(f.db.getRetryPart(f.r.id),'full');
 assert.equal(f.db.providerRemovals(f.r.id).length,0);
 assert.equal(f.db.getUploadIdentity(f.r.id),null);
 assert.equal(f.raw.prepare('SELECT remote_id FROM upload_attempts').get().remote_id,'123');
 assert.equal(f.db.uploadUsage('2026-10').spent,10);
 assert.equal(f.db.dueUploadConfirmations(day(8)).length,0);
});

test('source removal preserves every ledger row and verification can complete without the original',async t=>{
 const f=await fixture(t);await submit(f);await rm(f.source,{recursive:true});
 await sweepMissingRecordings(f.db,f.config,day(8));
 assert(f.db.get(f.r.id));assert(f.db.getArtifact(f.r.id));
 assert.equal(f.raw.prepare('SELECT status FROM local_source_presence').get().status,'missing');
 await reconcileDueUploads(f.config,day(8),browser(async()=>({outcome:'online',remoteUrl:'https://www.porntrex.com/video/123/title/'})));
 assert(['upload_verified','cleanup_eligible'].includes(f.db.get(f.r.id).state));
 assert.equal(f.db.listVerifiedUploadParts(f.r.id).length,1);
});

test('uncaptured ID, changed conversions, and inconclusive probes never authorize deletion/re-upload',async t=>{
 const f=await fixture(t);await submit(f,null);
 const {cleanupAcceptedConversions}=await import('../dist/commands/acceptedConversions.js');
 await cleanupAcceptedConversions(f.db,f.config,start);await access(f.artifact.path);
 assert.equal(f.raw.prepare('SELECT accepted_at FROM upload_artifact_receipts').get().accepted_at,null);
});

test('corrupt or replaced generated bytes are retained, independently of accepted progress',async t=>{
 const f=await fixture(t);await submit(f);await writeFile(f.artifact.path,'replacement');
 const {cleanupAcceptedConversions}=await import('../dist/commands/acceptedConversions.js');
 const result=await cleanupAcceptedConversions(f.db,f.config,start);
 assert.match(result[0].error,/no longer matches/);await access(f.artifact.path);
 assert.equal(f.raw.prepare('SELECT deleted_at FROM upload_artifact_receipts').get().deleted_at,null);
});

test('missing or changed originals defer a retry while remote checks and receipts survive',async t=>{
 const f=await fixture(t);await submit(f);await writeFile(path.join(f.source,'0.ts'),'changed original');
 await reconcileDueUploads(f.config,day(7),browser(async()=>({outcome:'missing',remoteUrl:null,reason:'confirmed absent'})));
 assert.equal(f.db.get(f.r.id).state,'upload_uncertain');
 assert.equal(f.raw.prepare('SELECT status FROM conversion_retries').get().status,'source_unavailable');
 assert.equal(f.db.providerRemovals(f.r.id).length,0);
 assert.equal(f.db.dueUploadConfirmations(day(8)).length,1);
 await reconcileDueUploads(f.config,day(8),browser(async()=>({outcome:'online',remoteUrl:'https://www.porntrex.com/video/123/title/'})));
 assert.equal(f.db.listVerifiedUploadParts(f.r.id).length,1);
});

test('network failure is inconclusive; confirmed processing after a week retries; next acceptance gets a fresh week',async t=>{
 const f=await fixture(t);await submit(f);
 await reconcileDueUploads(f.config,day(7),browser(async()=>{throw Error('HTTP 502');}));
 assert.equal(f.db.get(f.r.id).state,'upload_uncertain');
 await reconcileDueUploads(f.config,day(8),browser(async()=>({outcome:'not_ready',remoteUrl:null,processing:true,reason:'Processing'})));
 assert.equal(f.db.get(f.r.id).state,'server_ready');
 f.db.transition(f.r.id,'server_ready','remuxed','retry',day(8));
 await writeFile(f.artifact.path,'conversion');
 f.db.saveArtifact(f.r.id,{...f.artifact,validatedAt:day(8).toISOString()},day(8));
 f.db.saveDescription(f.r.id,{artifactSha256:f.artifact.sha256,promptVersion:'test',fps:1,output:{title:'retry'},evidencePath:path.join(f.root,'retry.json')},day(8));
 f.db.saveUploadMetadata(f.r.id,{title:'Retry',description:'Retry',tags:[]},day(8));
 const reservation=f.db.reserveUpload(f.r.id,20,day(8));
 const attempt=f.db.beginUpload(f.r.id,reservation,day(8));
 f.db.finishUploadAttempt(attempt,{status:'uncertain',remoteId:'124',transmittedBytes:10,acceptedAt:day(8),confirmation:{confirmAfter:day(15)}},day(8));
 assert.equal(f.db.dueUploadConfirmations(day(14)).length,0);
 assert.equal(f.db.dueUploadConfirmations(day(15)).length,1);
 assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM upload_attempts').get().n,2);
 assert.equal(f.db.uploadUsage('2026-10').spent,20);
});

test('a known provider removal still blocks both cleanup and retry',async t=>{
 const f=await fixture(t);await submit(f);
 const attempt=f.raw.prepare('SELECT id FROM upload_attempts').get().id;
 f.db.markProviderRemoved(attempt,'123','copyright removal',day(1));
 const {cleanupAcceptedConversions}=await import('../dist/commands/acceptedConversions.js');
 await cleanupAcceptedConversions(f.db,f.config,day(7));await access(f.artifact.path);
 assert.equal(f.db.retryAcceptedConversion(attempt,true,'retry',day(7)),false);
 assert.equal(f.db.get(f.r.id).state,'blocked');
});

test('legacy migration is idempotent, moves acceptance deadlines to a week, and retains rendition holds',async t=>{
 const f=await fixture(t);await submit(f);
 f.raw.exec('DELETE FROM upload_artifact_receipts;UPDATE schema_version SET version=14');
 f.raw.prepare('UPDATE upload_confirmations SET confirm_after=?').run(day(1).toISOString());
 let migrated=new PipelineDatabase(f.config.databasePath);migrated.close();
 assert.equal(f.db.dueUploadConfirmations(day(6)).length,0);
 assert.equal(f.db.dueUploadConfirmations(day(7)).length,1);
 const first=f.raw.prepare('SELECT * FROM upload_artifact_receipts').get();
 migrated=new PipelineDatabase(f.config.databasePath);migrated.close();
 assert.deepEqual(f.raw.prepare('SELECT * FROM upload_artifact_receipts').get(),first);
 f.raw.exec('DELETE FROM upload_artifact_receipts;UPDATE schema_version SET version=14');
 f.raw.prepare('UPDATE upload_attempts SET evidence_json=?').run(JSON.stringify([{stage:'playback_verification',outcome:'not_ready',remoteUrl:'https://example.test/published',renditions:[{width:960,height:720}]}]));
 migrated=new PipelineDatabase(f.config.databasePath);migrated.close();
 assert.match(f.raw.prepare('SELECT retention_hold FROM upload_artifact_receipts').get().retention_hold,/rendition/);
 const {cleanupAcceptedConversions}=await import('../dist/commands/acceptedConversions.js');
 await cleanupAcceptedConversions(f.db,f.config,start);await access(f.artifact.path);
});

test('SIGKILL after durable acceptance resumes deletion and the original seven-day deadline',async t=>{
 const f=await fixture(t);
 const {spawn}=await import('node:child_process');
 const {once}=await import('node:events');
 const child=spawn(process.execPath,['--no-warnings','--input-type=module','-e',`
 import {PipelineDatabase} from ${JSON.stringify(new URL('../dist/db/pipelineDatabase.js',import.meta.url).href)};
 const db=new PipelineDatabase(process.argv[1]),id=process.argv[2],now=new Date(process.argv[3]);
 const a=db.beginUpload(id,db.reserveUpload(id,20,now),now);
 db.updateUploadProgress(a,'metadata_submitting',10,now);
 db.recordUploadEvidence(a,{stage:'file_transfer_complete',bytesAcknowledged:10},now);
 db.recordUploadEvidence(a,{stage:'remote_identity_captured',remoteId:'125'},now);
 process.stdout.write('durable');setInterval(()=>{},1000);
 `,f.config.databasePath,f.r.id,start.toISOString()],{stdio:['ignore','pipe','pipe']});
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 await once(child.stdout,'data');const exited=once(child,'exit');child.kill('SIGKILL');await exited;
 f.db.recoverInterruptedUploads(day(1));f.db.releaseAllLeases();
 const {cleanupAcceptedConversions}=await import('../dist/commands/acceptedConversions.js');
 await cleanupAcceptedConversions(f.db,f.config,day(1));
 await assert.rejects(access(f.artifact.path),{code:'ENOENT'});
 assert.equal(f.db.dueUploadConfirmations(day(6)).length,0);
 assert.equal(f.db.dueUploadConfirmations(day(7)).length,1);
 assert.equal(f.db.uploadUsage('2026-10').spent,10);
});

test('split retries replace only their failed part, retain other queued bytes and require full coverage',async t=>{
 const f=await fixture(t);
 const other={...f.artifact,part:'shape2',path:path.join(f.config.stagingRoot,'other.mp4'),segmentCount:1,sourceDimensions:['720x1280']};
 await writeFile(other.path,'conversion');
 f.raw.prepare("UPDATE artifacts SET part='shape1'").run();
 f.raw.prepare('INSERT INTO production_artifact_queue VALUES(?,?,?,?,?,?,?,?,?)').run(f.r.id,other.part,0,other.path,10,other.sha256,1,JSON.stringify(other.sourceDimensions),start.toISOString());
 await submit(f);
 await reconcileDueUploads(f.config,day(7),browser(async()=>({outcome:'missing',remoteUrl:null})));
 assert.equal(f.db.getRetryPart(f.r.id),'shape1');
 const replacement={...f.artifact,part:'shape1',segmentCount:1,sourceDimensions:['1280x720']};
 await writeFile(replacement.path,'conversion');
 f.db.saveProductionArtifactSet(f.r.id,replacement,[],'retry one shape',day(7));
 assert.deepEqual(f.db.listQueuedProductionArtifacts(f.r.id).map(a=>a.path),[other.path]);await access(other.path);
 f.db.saveDescription(f.r.id,{artifactSha256:replacement.sha256,promptVersion:'test',fps:1,output:{title:'retry'},evidencePath:path.join(f.root,'retry.json')},day(7));
 f.db.saveUploadMetadata(f.r.id,{title:'Retry',description:'Retry',tags:[]},day(7));
 const a=f.db.beginUpload(f.r.id,f.db.reserveUpload(f.r.id,20,day(7)),day(7));
 f.db.finishUploadAttempt(a,{status:'uncertain',remoteId:'126',transmittedBytes:10,acceptedAt:day(7),confirmation:{confirmAfter:day(14)}},day(7));
 await reconcileDueUploads(f.config,day(14),browser(async()=>({outcome:'online',remoteUrl:'https://www.porntrex.com/video/126/title/'})));
 assert.equal(f.db.get(f.r.id).state,'artifact_valid');assert.equal(f.db.getArtifactPart(f.r.id),'shape2');
 assert.equal(f.db.listVerifiedUploadParts(f.r.id).length,1);await access(other.path);
 assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM upload_artifact_receipts').get().n,2);
});

test('retry conversion encodes only the selected shape from a real multi-shape playlist',async t=>{
 const f=await fixture(t);
 const {fixturePart,assemble}=await import('./helpers/mediaFixture.mjs');
 const {createDefaultStages}=await import('../dist/stages/defaultStages.js');
 const {PipelineOrchestrator}=await import('../dist/scheduler/orchestrator.js');
 const left=await fixturePart(f.root,'landscape',{size:'320x180',frames:4});
 const right=await fixturePart(f.root,'portrait',{size:'180x320',frames:4});
 await assemble(f.source,[left,right],[121,121]);
 const input=(await inspectFinalizedRecording(f.source,'sc','edited')).recording;
 f.raw.prepare('UPDATE recordings SET source_fingerprint=? WHERE id=?').run(input.sourceFingerprint,f.r.id);
 f.raw.prepare("UPDATE artifacts SET part='shape2'").run();
 await submit(f);
 await reconcileDueUploads(f.config,day(7),browser(async()=>({outcome:'missing',remoteUrl:null})));
 const worker=new PipelineOrchestrator(f.db,createDefaultStages(f.config.stagingRoot,f.config),'real-shape-retry');
 assert.equal((await worker.processRecording(f.r.id)).state,'artifact_valid');
 assert.equal(f.db.getArtifactPart(f.r.id),'shape2');
 assert.equal(f.db.listQueuedProductionArtifacts(f.r.id).length,0);
 const {readdir}=await import('node:fs/promises');
 assert.deepEqual((await readdir(f.config.stagingRoot)).filter(name=>name.endsWith('.mp4')),[`${f.r.id}.production-v6-shape2-ccw.mp4`]);
});
