import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PipelineDatabase } from '../dist/db/pipelineDatabase.js';
import { pipelineConfig } from '../dist/config.js';
import { TargetCatalogResolver } from '../dist/provenance/targetResolver.js';
import { inspectFinalizedRecording } from '../dist/discovery/inspectRecording.js';
import { verifyCurrentServerAuthority } from '../dist/discovery/verifyCurrentAuthority.js';
import { cancelInvalidShortBatch, compatibleShortGroups, maintainAutomaticShorts, poolRecordingPart } from '../dist/campaign/shorts.js';
import { CampaignWorker } from '../dist/campaign/campaignWorker.js';
import { createDefaultStages } from '../dist/stages/defaultStages.js';

const mediaRoot = await mkdtemp(path.join(os.tmpdir(), 'short-test-media-'));
after(() => rm(mediaRoot, { recursive: true, force: true }));
async function media(width, height, duration) {
    const filename = path.join(mediaRoot, `${width}x${height}-${duration}.ts`);
    try { await readFile(filename); } catch {
        execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i',`color=c=blue:s=${width}x${height}:r=1`,
            '-t',String(duration),'-c:v','libx264','-preset','ultrafast','-g','1','-an','-f','mpegts',filename]);
    }
    return filename;
}

async function fixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pipeline-shorts-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const databasePath = path.join(root, 'pipeline.sqlite');
    const finalizationDatabasePath = path.join(root, 'finalization.sqlite');
    const authority = new DatabaseSync(finalizationDatabasePath);
    authority.exec('CREATE TABLE integrity_checkpoints(recording_path TEXT PRIMARY KEY,playlist_fingerprint TEXT,report_json TEXT,updated_at TEXT)');
    t.after(() => authority.close());
    const database = new PipelineDatabase(databasePath);
    t.after(() => database.close());
    const sources = path.join(root, 'tango/edited');
    await mkdir(sources, { recursive: true });
    const config = { ...pipelineConfig, databasePath, finalizationDatabasePath, automaticShortsEnabled:true,
        stagingRoot:path.join(root,'artifacts/production-v6'), artifactsRoot:path.join(root,'artifacts'),
        discoveryRoots:['tango','fc2','sc'].map(provider=>({provider,sourceKind:'edited',path:path.join(root,provider,'edited')})), uploadProvider:'porntrex', cleanupEnabled:false };
    const resolver = TargetCatalogResolver.load({ resolveIdentifier:async (_provider, alias) => ({id:alias.startsWith('alice')?'alice-id':alias,label:alias}) });
    let index = 0;
    async function add(alias='alice', pieces=[[64,36,65]]) {
        const id = `2026-01-01 0000${String(index++).padStart(2,'0')} ${alias}`;
        const source = path.join(sources,id);
        await mkdir(source);
        const lines=['#EXTM3U','#EXT-X-TARGETDURATION:200'];
        for(let i=0;i<pieces.length;i++) {
            const [w,h,d]=pieces[i];
            await copyFile(await media(w,h,d),path.join(source,`${i}.ts`));
            if(i)lines.push('#EXT-X-DISCONTINUITY');
            lines.push(`#EXTINF:${d},`,`${i}.ts`);
        }
        lines.push('#EXT-X-ENDLIST','');
        const playlist=lines.join('\n');
        await writeFile(path.join(source,'playlist.m3u8'),playlist);
        authority.prepare('INSERT INTO integrity_checkpoints VALUES(?,?,?,?)').run(source,
            createHash('sha256').update(playlist).digest('hex'),JSON.stringify({version:2,status:'ready'}),new Date().toISOString());
        const result=await inspectFinalizedRecording(source,'tango','edited');
        assert.equal(result.status,'finalized');
        return {id,source,input:result.recording,playlist};
    }
    async function verified(batchId, remoteId='123') {
        const artifactPath=path.join(root,`${remoteId}.mp4`);
        await writeFile(artifactPath,'validated fixture');
        if(!database.getArtifact(batchId)){
            database.saveRemuxOutput(batchId,artifactPath);
            database.saveArtifact(batchId,{path:artifactPath,sizeBytes:17,sha256:'a'.repeat(64),validatedAt:new Date().toISOString()});
        }
        const raw=new DatabaseSync(databasePath);
        raw.prepare("UPDATE recordings SET state='uploaded' WHERE id=?").run(batchId);
        raw.prepare(`INSERT INTO upload_attempts(id,recording_id,provider,status,phase,remote_id,remote_url,started_at,completed_at,artifact_part)
            VALUES(?,?,'porntrex','accepted','metadata_submitting',?,?,?,?,?)`).run(`attempt-${remoteId}`,batchId,remoteId,
                `https://www.porntrex.com/video/${remoteId}/fixture`,new Date().toISOString(),new Date().toISOString(),database.getArtifactPart(batchId)??'full');
        raw.close();
        return database.markRemoteVerified(batchId,remoteId,`https://www.porntrex.com/video/${remoteId}/fixture`);
    }
    return {root,database,config,resolver,add,verified,authority};
}

const part=(id,seconds,aspect=16/9,streamer='tango:alice',destination='porntrex')=>({recordingId:id,part:'full',
    sourceFingerprint:'hash',streamerKey:streamer,destinationProvider:destination,aspectRatio:aspect,
    durationSeconds:seconds,playlist:'',batchId:null,verified:false});

test('groups only the same resolved streamer, destination and compatible shape',()=>{
    const clips=[part('a',65),part('b',65,16/9,'tango:bob'),part('c',65,9/16),
        part('d',65,16/9,'tango:alice','retired'),part('e',65)];
    assert.deepEqual(compatibleShortGroups(clips,121).map(g=>g.map(p=>p.recordingId)),[['a','e']]);
});
test('incompatible earliest clip cannot starve a later compatible pair',()=>{
    assert.deepEqual(compatibleShortGroups([part('a',10,1),part('b',65,1.009),part('c',65,1.018)],121)
        .map(g=>g.map(p=>p.recordingId)),[['b','c']]);
});
test('insufficient or already assigned footage stays out of a new batch',()=>{
    assert.equal(compatibleShortGroups([part('a',60),part('b',60)],121).length,0);
    assert.equal(compatibleShortGroups([{...part('a',65),batchId:'existing'},part('b',65)],121).length,0);
});

test('campaign automatically parks an isolated short and continues without a manual block',async t=>{
    const f=await fixture(t);const clip=await f.add();
    f.database.setCampaignState('running');
    const step=await new CampaignWorker(f.database,f.config,f.resolver).step();
    assert.equal(step.disposition,'shorts_waiting');
    assert.equal(f.database.get(clip.id).state,'short_waiting');
    assert.deepEqual(await readFile(path.join(clip.source,'playlist.m3u8'),'utf8'),clip.playlist);
});

test('prepared batches cannot leapfrog older discovery or an older upload-ready recording',async t=>{
    const f=await fixture(t);const old=await f.add('bob',[[64,36,200]]);await f.add();await f.add();
    const uploaded=[];const processed=[];
    f.database.setCampaignState('running');
    const worker=new CampaignWorker(f.database,f.config,f.resolver,async id=>{uploaded.push(id);return {};});
    const first=await worker.step();assert.equal(first.disposition,'shorts_joined');
    worker.orchestrator.processRecording=async id=>{processed.push(id);throw new Error('newer batch ran ahead of older work');};
    const second=await worker.step();assert.equal(second.disposition,'admitted');assert.equal(second.recordingId,old.id);
    const file=path.join(f.root,'older.mp4');await writeFile(file,'fixture');
    f.database.saveRemuxOutput(old.id,file);
    f.database.saveArtifact(old.id,{path:file,sizeBytes:7,sha256:'a'.repeat(64),validatedAt:new Date().toISOString()});
    const raw=new DatabaseSync(f.config.databasePath);raw.prepare("UPDATE recordings SET state='metadata_ready' WHERE id=?").run(old.id);raw.close();
    f.database.recordResolutionPolicyAssessment(old.id,'resolution-policy-v6: test fixture');
    const third=await worker.step();assert.equal(third.disposition,'upload_completed');
    assert.deepEqual(uploaded,[old.id]);assert.deepEqual(processed,[]);
});

test('all required short parts are classified atomically',async t=>{
    const f=await fixture(t);const clip=await f.add();const recording=f.database.discover(clip.input);
    const first={...part(recording.id,65),sourceFingerprint:recording.sourceFingerprint,part:'shape1'};
    const second={...first,part:'shape2',sourceFingerprint:'different fingerprint'};
    assert.throws(()=>f.database.saveShortParts([first,second]),/fingerprint/);
    assert.equal(f.database.shortParts(recording.id).length,0);
});

test('pipeline joins compatible shorts through canonical streamer identity, preserving originals and boundaries',async t=>{
    const f=await fixture(t);const a=await f.add('alice-old');const b=await f.add('alice-new');
    const firstBytes=await readFile(path.join(a.source,'0.ts'));
    const result=await maintainAutomaticShorts(f.database,f.config,f.resolver);
    assert.equal(result.joined.length,1);const batch=f.database.get(result.joined[0]);
    assert.equal(batch.durationSeconds,130);
    assert.equal(f.database.get(a.id).state,'short_joined');
    const text=await readFile(batch.playlistPath,'utf8');assert.match(text,/#EXT-X-DISCONTINUITY/);
    assert.equal(await realpath(path.join(batch.sourcePath,'0_0.ts')),path.join(a.source,'0.ts'));
    assert.deepEqual(await readFile(path.join(a.source,'0.ts')),firstBytes);
    assert.equal(await readFile(path.join(a.source,'playlist.m3u8'),'utf8'),a.playlist);
    await verifyCurrentServerAuthority(batch,f.config,f.database);
    await assert.rejects(verifyCurrentServerAuthority(batch,f.config),/checkpoint/);
    const again=await maintainAutomaticShorts(f.database,f.config,f.resolver,new Date(Date.now()+10*60_000));
    assert.equal(again.joined.length,0);
    assert.equal(f.database.shortParts(b.id)[0].batchId,batch.id);
});

test('long streamer labels leave room for filesystem-safe artifact names without losing member identity',async t=>{
    const f=await fixture(t);const alias='alice'+'x'.repeat(170);const original=await f.add(alias);await f.add(alias);
    const result=await maintainAutomaticShorts(f.database,f.config,f.resolver);assert.equal(result.joined.length,1);
    const batch=f.database.get(result.joined[0]);
    assert.ok(Buffer.byteLength(path.basename(batch.sourcePath)+'.production-v6-ccw.mp4')<=255);
    assert.equal(f.database.shortParts(original.id)[0].batchId,batch.id);
    assert.match(batch.id,/^2026-01-01 000000 /);
});

test('different shapes remain in separate waiting pools',async t=>{
    const f=await fixture(t);const a=await f.add();const b=await f.add('alice',[[36,64,65]]);
    const result=await maintainAutomaticShorts(f.database,f.config,f.resolver);
    assert.equal(result.joined.length,0);
    assert.equal(f.database.get(a.id).state,'short_waiting');
    assert.equal(f.database.get(b.id).state,'short_waiting');
});

test('two compatible sixty-second recordings meet the two-minute minimum exactly',async t=>{
    const f=await fixture(t);await f.add('alice',[[64,36,60]]);await f.add('alice',[[64,36,60]]);
    const result=await maintainAutomaticShorts(f.database,f.config,f.resolver);
    assert.equal(result.joined.length,1);
    assert.equal(f.database.get(result.joined[0]).durationSeconds,120);
});

test('a short part pools independently while the longer compatible job continues without duplicate coverage',async t=>{
    const f=await fixture(t);const original=await f.add('alice',[[64,36,65],[36,64,200]]);
    const recorded=f.database.discover(original.input);f.database.saveProvenance(recorded.id,await f.resolver.resolve(original.input));
    const artifact=(part)=>({part,path:path.join(f.root,`${part}.mp4`),sizeBytes:17,sha256:'a'.repeat(64),
        validatedAt:new Date().toISOString(),segmentCount:1,sourceDimensions:[part==='shape1'?'64x36':'36x64']});
    f.database.saveProductionArtifactSet(recorded.id,artifact('shape1'),[artifact('shape2')],'resolution-policy-v6: fixture');
    const raw=new DatabaseSync(f.config.databasePath);raw.prepare("UPDATE recordings SET state='metadata_ready' WHERE id=?").run(recorded.id);raw.close();
    await poolRecordingPart(f.database,recorded,'porntrex','shape1',65);
    f.database.deferShortArtifact(recorded.id,'porntrex');
    assert.equal(f.database.get(recorded.id).state,'artifact_valid');
    assert.equal(f.database.getArtifactPart(recorded.id),'shape2');
    await f.add('alice');
    const result=await maintainAutomaticShorts(f.database,f.config,f.resolver);assert.equal(result.joined.length,1);
    assert.equal(f.database.get(result.joined[0]).durationSeconds,130);
    await f.verified(result.joined[0],'300');
    assert.equal(f.database.get(recorded.id).state,'artifact_valid');
    assert.equal(f.database.getUploadIdentity(recorded.id),null,'coverage of shape1 must not falsely cover shape2');
    await f.verified(recorded.id,'301');
    assert.equal(f.database.get(recorded.id).state,'upload_verified');
    assert.deepEqual(f.database.listVerifiedUploadParts(recorded.id).map(p=>p.part).sort(),['shape1','shape2']);
});

test('verification covers every original only after the complete joined upload is verified',async t=>{
    const f=await fixture(t);const a=await f.add();const b=await f.add();
    const result=await maintainAutomaticShorts(f.database,f.config,f.resolver);
    assert.equal(f.database.get(a.id).state,'short_joined');
    assert.equal(f.database.getUploadIdentity(a.id),null);
    await f.verified(result.joined[0]);
    for(const member of [a,b]){
        assert.equal(f.database.get(member.id).state,'cleanup_eligible');
        assert.equal(f.database.getUploadIdentity(member.id).verified,true);
        assert.equal(f.database.listVerifiedUploadParts(member.id)[0].remoteId,'123');
    }
    const raw=new DatabaseSync(f.config.databasePath);
    raw.prepare("UPDATE recordings SET source_fingerprint='changed' WHERE id=?").run(a.id);raw.close();
    assert.equal(f.database.listVerifiedUploadParts(a.id).length,0,'old batch cannot cover an edited replacement');
    assert.equal(f.database.getUploadIdentity(a.id),null);
});

test('multi-shape originals need a verified batch for each of their compatible parts',async t=>{
    const f=await fixture(t);
    const multi=await f.add('alice',[[64,36,55],[36,64,55]]);
    await f.add('alice',[[64,36,70]]);await f.add('alice',[[36,64,70]]);
    const result=await maintainAutomaticShorts(f.database,f.config,f.resolver);
    assert.equal(result.joined.length,2);
    await f.verified(result.joined[0],'100');
    assert.equal(f.database.get(multi.id).state,'short_joined');
    await f.verified(result.joined[1],'101');
    assert.equal(f.database.get(multi.id).state,'cleanup_eligible');
    assert.equal(f.database.listVerifiedUploadParts(multi.id).length,2);
});

test('a newly changed original invalidates joined authority before conversion or upload',async t=>{
    const f=await fixture(t);const a=await f.add();await f.add();
    const result=await maintainAutomaticShorts(f.database,f.config,f.resolver);
    await writeFile(path.join(a.source,'0.ts'),'changed bytes');
    await assert.rejects(verifyCurrentServerAuthority(f.database.get(result.joined[0]),f.config,f.database),/changed|not finalized/);
    assert.equal(await cancelInvalidShortBatch(f.database,f.config,result.joined[0],'source changed'),true);
    assert.equal(f.database.get(result.joined[0]).state,'short_cancelled');
    assert.equal(f.database.get(a.id).state,'short_waiting');
});

test('user deletion cancels an unsent batch without restoring files or blocking other work',async t=>{
    const f=await fixture(t);const a=await f.add();const b=await f.add();
    const result=await maintainAutomaticShorts(f.database,f.config,f.resolver);
    await rm(a.source,{recursive:true});
    f.database.setCampaignState('running');
    const step=await new CampaignWorker(f.database,f.config,f.resolver).step();
    assert.equal(step.state,'short_cancelled');
    assert.equal(f.database.get(a.id).state,'short_cancelled');
    assert.equal(f.database.get(b.id).state,'short_waiting');
    assert.equal(f.database.shortParts(b.id)[0].batchId,null);
    assert.equal((await maintainAutomaticShorts(f.database,f.config,f.resolver)).joined.length,0);
    await assert.rejects(readFile(path.join(a.source,'playlist.m3u8')),/ENOENT/);
    assert.ok(await readFile(path.join(b.source,'0.ts')));
    assert.equal(f.database.get(result.joined[0]).state,'short_cancelled');
});

test('fMP4 joins preserve separate init maps and fragment boundaries',async t=>{
    const f=await fixture(t);
    const sourceRoot=path.join(f.root,'sc/edited');await mkdir(sourceRoot,{recursive:true});
    for(let index=0;index<2;index++){
        const source=path.join(sourceRoot,`2026-01-01 00000${index} alice`);await mkdir(source);
        execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=64x36:r=1','-t','65','-c:v','libx264',
            '-preset','ultrafast','-g','1','-an','-f','hls','-hls_segment_type','fmp4','-hls_time','65',
            '-hls_playlist_type','vod','-hls_segment_filename',path.join(source,'segment-%d.m4s'),path.join(source,'playlist.m3u8')]);
        const text=await readFile(path.join(source,'playlist.m3u8'),'utf8');
        f.authority.prepare('INSERT INTO integrity_checkpoints VALUES(?,?,?,?)').run(source,
            createHash('sha256').update(text).digest('hex'),JSON.stringify({version:2,status:'ready'}),new Date().toISOString());
    }
    const result=await maintainAutomaticShorts(f.database,f.config,f.resolver);assert.equal(result.joined.length,1);
    const batch=f.database.get(result.joined[0]);const text=await readFile(batch.playlistPath,'utf8');
    assert.equal((text.match(/#EXT-X-MAP:/g)??[]).length,2);
    assert.match(text,/#EXT-X-DISCONTINUITY/);
    await verifyCurrentServerAuthority(batch,f.config,f.database);
});

test('removed recordings cannot be smuggled into a new batch for the same provider',async t=>{
    const f=await fixture(t);const a=await f.add();await f.add();
    const recording=f.database.discover(a.input);f.database.saveProvenance(recording.id,await f.resolver.resolve(a.input));
    const raw=new DatabaseSync(f.config.databasePath);
    raw.prepare('INSERT INTO provider_removals VALUES(?,?,?,?,?)').run(a.id,'porntrex','old-id','removed',new Date().toISOString());raw.close();
    assert.throws(()=>f.database.waitForShorts(a.id,'porntrex'),/Removed/);
    await assert.rejects(poolRecordingPart(f.database,recording,'porntrex'),/removed/);
});

test('compatible joined source uses the normal conversion and artifact validation stages',async t=>{
    const f=await fixture(t);await f.add();await f.add();
    const result=await maintainAutomaticShorts(f.database,f.config,f.resolver);
    const batch=f.database.get(result.joined[0]);
    const stages=createDefaultStages(f.config.stagingRoot);
    const converted=await stages.remux(batch);
    assert.equal(converted.disposition,'artifact');
    const validated=await stages.validateArtifact(batch,converted.path);
    assert.ok(validated.sizeBytes>0);assert.match(validated.sha256,/^[a-f0-9]{64}$/);
});
