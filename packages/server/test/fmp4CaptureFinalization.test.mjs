import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseNativeMediaPlaylist } from 'shared';
import { FinalizationCheckpointStore } from '../dist/services/hls/finalizationCheckpointStore.js';
import { processFinalizedRecording } from '../dist/services/hls/finalizedRecordingProcessor.js';
import { finalizeFmp4Capture } from '../dist/services/hls/fmp4CaptureFinalization.js';
import { avcNals, readAvcInitialization, readCaptureChunks, writeCaptureChunk } from '../dist/services/hls/fmp4Samples.js';

const hash = b => createHash('sha256').update(b).digest('hex');
async function fixture(t, modify = () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'avc-capture-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const folder = path.join(root,'recording'); await mkdir(folder);
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=160x90:rate=10','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2','-c:v','libx264','-preset','ultrafast','-profile:v','baseline','-bf','0','-g','10','-sc_threshold','0','-x264-params','repeat-headers=1','-c:a','aac','-hls_time','3','-hls_segment_type','fmp4','-hls_fmp4_init_filename','init.mp4','-hls_segment_filename',path.join(folder,'part%d.ts'),'-f','hls',path.join(folder,'playlist.m3u8')]);
  const initBytes = await readFile(path.join(folder,'init.mp4'));
  const init = readAvcInitialization(initBytes);
  const chunks = readCaptureChunks(await readFile(path.join(folder,'part0.ts')),init);
  const video = chunks[0].runs.find(r=>r.track.kind==='vide');
  assert.equal(video.samples.length,20);
  const sps = avcNals(video.samples[10],init.lengthBytes).find(n=>(n[0]&31)===7);
  sps[3] += 1; // actual in-band level-only transition at the second IDR, inside one moof
  modify({chunks,video,sps,init});
  const original = Buffer.concat(chunks.map(c=>writeCaptureChunk(c.sequence,c.runs)));
  await writeFile(path.join(folder,'part0.ts'),original);
  const playlist = await readFile(path.join(folder,'playlist.m3u8'),'utf8');
  const db = path.join(root,'checkpoints.sqlite');
  const store = new FinalizationCheckpointStore(db); t.after(()=>store.close());
  return {root,folder,db,store,init,initBytes,original,playlist,chunks};
}
function identity(chunks) {
  const tracks = new Map();
  for (const c of chunks) for (const r of c.runs) {
    if (!tracks.has(r.track.id)) tracks.set(r.track.id,[]);
    tracks.get(r.track.id).push(...r.samples.map(s=>[s.dts,s.duration,s.cto,s.flags,hash(s.bytes)]));
  }
  return tracks;
}
async function published(f) {
  const text = await readFile(path.join(f.folder,'playlist.m3u8'),'utf8');
  const p = parseNativeMediaPlaylist(text), chunks = [];
  for (const s of p.segments) {
    const init = readAvcInitialization(await readFile(path.join(f.folder,s.mapUri)));
    const cs = readCaptureChunks(await readFile(path.join(f.folder,s.name)),init);
    for (const v of cs.flatMap(c=>c.runs).filter(r=>r.track.kind==='vide').flatMap(r=>r.samples)) {
      for (const n of avcNals(v,init.lengthBytes)) if ((n[0]&31)===7) assert.equal(n[3],init.sps[3]);
    }
    chunks.push(...cs);
  }
  assert.deepEqual(identity(chunks),identity(f.chunks),'all encoded samples, flags and clocks must be identical, in order');
  assert.deepEqual(await readFile(path.join(f.folder,'part0.ts')),f.original);
  assert.deepEqual(await readFile(path.join(f.folder,'init.mp4')),f.initBytes);
  return {text,p,chunks};
}

test('default finalization splits an in-moof AVC transition and retains every original sample',async t=>{
  const f=await fixture(t);
  const result=await processFinalizedRecording(f.folder,{checkpointStore:f.store,validateMedia:async()=>({valid:true,exitCode:0,stderr:''}),inspectFragment:async()=>null});
  const {p,text}=await published(f);
  assert.equal(p.segments.length,2);
  assert.notEqual(p.segments[0].mapUri,p.segments[1].mapUri);
  assert.equal(p.segments[1].metadata.includes('#EXT-X-DISCONTINUITY'),true);
  assert.ok(result.report.warnings.some(w=>w.kind==='decoder-boundary-split'));
  assert.ok(!result.report.warnings.some(w=>w.kind==='unreferenced-media'));
  const {DatabaseSync}=await import('node:sqlite'); const db=new DatabaseSync(f.db,{readOnly:true});
  const rows=db.prepare('SELECT value FROM finalization_meta').all(); db.close();
  const j=JSON.parse(rows.find(r=>JSON.parse(r.value).candidatePlaylist===text).value);
  assert.equal(j.originalPlaylist,f.playlist); assert.equal(j.phase,'published');
  const before=await readdir(f.folder); const again=await finalizeFmp4Capture(f.folder,f.store);
  assert.equal(again.changed,false); assert.deepEqual(await readdir(f.folder),before);
  assert.equal(await readFile(path.join(f.folder,'playlist.m3u8'),'utf8'),text);
});

test('lossless split also preserves independently decoded video frame hashes',async t=>{
  const f=await fixture(t); const source=path.join(f.root,'source.mp4');
  await writeFile(source,Buffer.concat([f.initBytes,f.original]));
  const frames=input=>execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-i',input,'-map','0:v','-f','framemd5','-'],{encoding:'utf8'}).split('\n').filter(l=>l&&!l.startsWith('#')).map(l=>l.split(',').at(-1).trim());
  const before=frames(source); await finalizeFmp4Capture(f.folder,f.store); await published(f);
  assert.deepEqual(frames(path.join(f.folder,'playlist.m3u8')),before);
});

test('a real held frame keeps its duration; independently rounded EXTINF is corrected from track clocks',async t=>{
  const f=await fixture(t,({video})=>{
    const hold=video.samples[9], extra=3*video.track.scale;
    hold.duration+=extra; for(const s of video.samples.slice(10))s.dts+=extra;
  });
  await finalizeFmp4Capture(f.folder,f.store); const {p}=await published(f);
  assert.equal(p.segments[0].durationSeconds,4);
  const v=readCaptureChunks(await readFile(path.join(f.folder,p.segments[0].name)),f.init)[0].runs.find(r=>r.track.kind==='vide');
  assert.equal(v.samples.at(-1).duration,3.1*v.track.scale);
});

for (const stage of ['prepared','published']) test(`restart after SIGKILL at ${stage} journal boundary preserves media and completes`,async t=>{
  const f=await fixture(t);
  const helper=new URL('../dist/services/hls/fmp4CaptureFinalization.js',import.meta.url).href;
  const storeModule=new URL('../dist/services/hls/finalizationCheckpointStore.js',import.meta.url).href;
  const code=`import{finalizeFmp4Capture}from ${JSON.stringify(helper)};import{FinalizationCheckpointStore}from ${JSON.stringify(storeModule)};const s=new FinalizationCheckpointStore(process.argv[2]);const put=s.setMeta.bind(s);s.setMeta=(k,v)=>{if(v.phase==='published'&&process.argv[3]==='published')process.kill(process.pid,'SIGKILL');put(k,v);if(v.phase==='prepared'&&process.argv[3]==='prepared')process.kill(process.pid,'SIGKILL');};await finalizeFmp4Capture(process.argv[1],s);`;
  const child=spawnSync(process.execPath,['--no-warnings','--input-type=module','-e',code,f.folder,f.db,stage]);
  assert.equal(child.signal,'SIGKILL',child.stderr?.toString());
  await finalizeFmp4Capture(f.folder,f.store); const {p}=await published(f); assert.equal(p.segments.length,2);
});

test('changed playlist after publication is left as the user supplied it',async t=>{
  const f=await fixture(t);await finalizeFmp4Capture(f.folder,f.store);
  const user='#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\npart0.ts\n#EXT-X-ENDLIST\n# user edit\n';
  await writeFile(path.join(f.folder,'playlist.m3u8'),user);
  const r=await finalizeFmp4Capture(f.folder,f.store);
  assert.equal(r.changed,false); assert.equal(r.warnings[0].kind,'decoder-boundary-unrepaired');
  assert.equal(await readFile(path.join(f.folder,'playlist.m3u8'),'utf8'),user);
});

test('unsupported SPS and non-IDR transitions never rewrite or discard source bytes',async t=>{
  for(const change of [({sps})=>{sps[4]^=1;},({video})=>{video.samples[10].flags|=0x10000;}]) {
    const f=await fixture(t,change);const before=await readdir(f.folder);
    const r=await finalizeFmp4Capture(f.folder,f.store);
    assert.equal(r.changed,false);assert.equal(r.warnings[0].kind,'decoder-boundary-unrepaired');
    assert.equal(await readFile(path.join(f.folder,'playlist.m3u8'),'utf8'),f.playlist);
    assert.deepEqual(await readFile(path.join(f.folder,'part0.ts')),f.original);
    assert.deepEqual(await readdir(f.folder),before);
  }
});

test('pending publication rename reuses its durable journal',async t=>{
  const f=await fixture(t);const pending=path.join(f.root,'.pending');await mkdir(pending);
  const hidden=path.join(pending,'recording');await rename(f.folder,hidden);
  await finalizeFmp4Capture(hidden,f.store);await rename(hidden,f.folder);
  const again=await finalizeFmp4Capture(f.folder,f.store);assert.equal(again.changed,false);await published(f);
});

test('a source changed after journal preparation is never overwritten or silently published',async t=>{
  const f=await fixture(t);const put=f.store.setMeta.bind(f.store);const replacement=Buffer.from('owner changed this source');
  f.store.setMeta=(key,value)=>{put(key,value);if(value.phase==='prepared')execFileSync(process.execPath,['-e','require("node:fs").writeFileSync(process.argv[1],process.argv[2])',path.join(f.folder,'part0.ts'),replacement.toString()]);};
  await assert.rejects(finalizeFmp4Capture(f.folder,f.store),/source changed/);
  assert.equal(await readFile(path.join(f.folder,'playlist.m3u8'),'utf8'),f.playlist);
  assert.deepEqual(await readFile(path.join(f.folder,'part0.ts')),replacement);
  f.store.setMeta=put;
  await assert.rejects(finalizeFmp4Capture(f.folder,f.store),/source changed/);
});

test('a generated filename conflict cannot replace pre-existing bytes',async t=>{
  const f=await fixture(t);const put=f.store.setMeta.bind(f.store);let conflict;
  f.store.setMeta=(key,value)=>{put(key,value);if(value.phase==='prepared'){conflict=value.outputs[0].name;execFileSync(process.execPath,['-e','require("node:fs").writeFileSync(process.argv[1],"pre-existing bytes")',path.join(f.folder,conflict)]);}};
  await assert.rejects(finalizeFmp4Capture(f.folder,f.store),/conflicts/);
  assert.equal(await readFile(path.join(f.folder,conflict),'utf8'),'pre-existing bytes');
  assert.equal(await readFile(path.join(f.folder,'playlist.m3u8'),'utf8'),f.playlist);
  assert.deepEqual(await readFile(path.join(f.folder,'part0.ts')),f.original);
});
