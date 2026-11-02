import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,rm,utimes} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {hlsPlaybackPresentation} from '../dist/services/hls/avcLevelContinuity.js';

const sha=data=>createHash('sha256').update(data).digest('hex');
async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'hls-avc-level-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const name='2026-01-01 010000 AVC-fixture',dir=path.join(root,'sc','downloaded',name);await mkdir(dir,{recursive:true});
 const file=path.join(dir,'synthetic.mp4');
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x96:rate=2','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t','4','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-profile:v','baseline','-level:v','3.1','-g','2','-bf','0','-x264-params','repeat-headers=1','-c:a','aac','-movflags','empty_moov+default_base_moof+frag_keyframe',file]);
 const bytes=await readFile(file),parts=[];let first=0;
 for(let at=0;at<bytes.length;){const size=bytes.readUInt32BE(at),type=bytes.toString('ascii',at+4,at+8);if(type==='moof'){if(first)parts.push(bytes.subarray(first,at));first=at;}at+=size;}
 parts.push(bytes.subarray(first));
 // The first media offset is also the end of the initialization.
 let initEnd=0;while(bytes.toString('ascii',initEnd+4,initEnd+8)!=='moof')initEnd+=bytes.readUInt32BE(initEnd);
 const initialization=bytes.subarray(0,initEnd);const avcc=initialization.indexOf(Buffer.from('avcC'));assert(avcc>0);
 const length=initialization.readUInt16BE(avcc+10),sps=initialization.subarray(avcc+12,avcc+12+length);assert.equal(sps[3],31);
 const changed=Buffer.from(sps);changed[3]=41;
 const upgrade=input=>{const result=Buffer.from(input);let count=0;for(let at=result.indexOf(sps);at>=0;at=result.indexOf(sps,at+sps.length)){changed.copy(result,at);count++;}assert(count>0,'Synthetic fragment needs repeated SPS');return result;};
 assert(parts.length>=4);
 const media=[parts[0],Buffer.concat([parts[1],upgrade(parts[2])]),upgrade(parts[3])];
 await writeFile(path.join(dir,'init.mp4'),initialization);for(const [i,data] of media.entries())await writeFile(path.join(dir,`${i}.ts`),data);
 const playlist='#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\n0.ts\n#EXTINF:2,\n1.ts\n#EXTINF:1,\n2.ts\n#EXT-X-ENDLIST\n';await writeFile(path.join(dir,'playlist.m3u8'),playlist);
 return {root,name,dir,playlist,media,initialization,parts,sps,upgrade};
}
test('mixed-level fragment gets avc3 and the following stable epoch gets a matching avc1 initialization',async t=>{
 const f=await fixture(t),result=await hlsPlaybackPresentation(f.dir,f.playlist);
 assert.deepEqual(result.boundaries,[{index:1,mode:'in-band',levels:[31,41]},{index:2,mode:'stable',levels:[41]}]);
 assert.equal(result.initializations.size,2);assert.equal((result.playlist.match(/#EXT-X-DISCONTINUITY/g)||[]).length,2);
 assert.deepEqual(result.playlist.split('\n').filter(x=>x.endsWith('.ts')),['0.ts','1.ts','2.ts']);
 const configs=[...result.initializations.values()];assert(configs.some(b=>b.includes(Buffer.from('avc3'))));assert(configs.some(b=>b.includes(Buffer.from('avc1'))&&b[b.indexOf(Buffer.from('avcC'))+7]===41));
 assert.equal(sha(await readFile(path.join(f.dir,'init.mp4'))),sha(f.initialization));
 for(const [i,data] of f.media.entries())assert.equal(sha(await readFile(path.join(f.dir,`${i}.ts`))),sha(data));
 assert.equal(await readFile(path.join(f.dir,'playlist.m3u8'),'utf8'),f.playlist);
 assert.strictEqual(await hlsPlaybackPresentation(f.dir,f.playlist),result);
 const fresh=await import('../dist/services/hls/avcLevelContinuity.js?restarted');const rebuilt=await fresh.hlsPlaybackPresentation(f.dir,f.playlist);
 assert.equal(rebuilt.playlist,result.playlist);assert.deepEqual([...rebuilt.initializations], [...result.initializations]);
 for(const [name,bytes] of result.initializations)await writeFile(path.join(f.dir,name),bytes);
 await writeFile(path.join(f.dir,'served.m3u8'),result.playlist);
 const pictures=file=>execFileSync('ffmpeg',['-v','error','-i',file,'-map','0:v:0','-f','framemd5','-']).toString().split('\n').filter(x=>x&&!x.startsWith('#')).map(x=>x.split(',').at(-1).trim());
 assert.deepEqual(pictures(path.join(f.dir,'served.m3u8')),pictures(path.join(f.dir,'playlist.m3u8')));
});
test('A/V endpoint timing removes cumulative EXTINF drift without compressing real source pauses',async t=>{
 const f=await fixture(t);const inflated=f.playlist.replaceAll('#EXTINF:1,','#EXTINF:3,').replaceAll('#EXTINF:2,','#EXTINF:4,');
 const result=await hlsPlaybackPresentation(f.dir,inflated);const durations=[...result.playlist.matchAll(/#EXTINF:([\d.]+)/g)].map(x=>Number(x[1]));
 assert.equal(durations.length,3);assert(result.durationCorrections>0);assert(durations.reduce((a,b)=>a+b,0)>3.9);assert(durations.reduce((a,b)=>a+b,0)<4.1);
 assert(durations[1]>1.9,'The two-second mixed fragment must retain its entire timeline');
});
test('changed source metadata invalidates the cache and unsupported SPS changes leave original media alone',async t=>{
 const f=await fixture(t);assert.equal((await hlsPlaybackPresentation(f.dir,f.playlist)).boundaries.length,2);
 const bytes=Buffer.from(f.media[1]),at=bytes.indexOf(f.sps);assert(at>=0);bytes[at+1]^=1;await writeFile(path.join(f.dir,'1.ts'),bytes);const time=new Date(Date.now()+1000);await utimes(path.join(f.dir,'1.ts'),time,time);
 const result=await hlsPlaybackPresentation(f.dir,f.playlist);assert.equal(result.playlist,f.playlist);assert.match(result.skippedReason,/more than its declared level/);
 await rm(f.dir,{recursive:true});await assert.rejects(()=>hlsPlaybackPresentation(f.dir,f.playlist),{code:'ENOENT'});
});
test('live and ordinary transport-stream playlists do not trigger an archive scan',async()=>{
 const live='#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\n0.ts\n';
 assert.equal((await hlsPlaybackPresentation('/missing-live-directory',live)).playlist,live);
 const ts='#EXTM3U\n#EXTINF:2,\n0.ts\n#EXT-X-ENDLIST\n';assert.equal((await hlsPlaybackPresentation('/missing-ts-directory',ts)).playlist,ts);
});
test('the HTTP presentation supplies decoder boundaries and generated maps while serving original media bytes',async t=>{
 const f=await fixture(t);
 // Shared layout is initialized at import time. Start the HTTP worker with its
 // temporary root already in the environment, rather than touching production.
 const code=String.raw`
 import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import express from 'express';
 const [root,name,routerURL,configURL]=process.argv.slice(1);const {getProviderPaths}=await import(configURL);assert.equal(getProviderPaths('sc').downloaded,path.join(root,'sc','downloaded'));
 const {default:router}=await import(routerURL);const app=express();app.use(router);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{const base='http://127.0.0.1:'+server.address().port+'/hls/sc/'+encodeURIComponent(name),dir=path.join(root,'sc','downloaded',name);
 const response=await fetch(base+'/playlist.m3u8');assert.equal(response.status,200);const playlist=await response.text();assert.equal((playlist.match(/#EXT-X-DISCONTINUITY/g)||[]).length,2);
 const names=[...playlist.matchAll(/URI="(_playback-init-[a-f0-9]+\.mp4)"/g)].map(x=>x[1]);assert.equal(names.length,2);
 for(const name of names){const map=await fetch(base+'/'+name);assert.equal(map.status,200);assert.equal(map.headers.get('content-type'),'video/mp4');assert((await map.arrayBuffer()).byteLength>100);}
 const original=await fetch(base+'/1.ts');assert.deepEqual(Buffer.from(await original.arrayBuffer()),await fs.readFile(path.join(dir,'1.ts')));
 assert.equal((await fetch(base+'/_playback-init-'+'0'.repeat(64)+'.mp4')).status,404);
 await fs.rm(dir,{recursive:true});assert.equal((await fetch(base+'/'+names[0])).status,404);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}`;
 await promisify(execFile)(process.execPath,['--input-type=module','-e',code,f.root,f.name,new URL('../dist/api/hls.routes.js',import.meta.url).href,new URL('../dist/core/config.js',import.meta.url).href],{env:{...process.env,VIDEO_DOWNLOADS_ROOT:f.root},timeout:20000});
});
