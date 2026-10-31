import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,readdir,rename,rm,symlink,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import {MP4Library} from '../dist/services/video/mp4Library.js';
import {createBunkrLibraryRoutes} from '../dist/api/bunkr-library.routes.js';
const execute=promisify(execFile);
async function fixture(t,probe=async()=>12.5){
    const root=await mkdtemp(path.join(os.tmpdir(),'bunkr-library-'));await mkdir(path.join(root,'media'));
    t.after(()=>rm(root,{recursive:true,force:true}));
    const options={stateFile:path.join(root,'state/index.json'),probe};const library=new MP4Library(path.join(root,'media'),options);
    t.after(()=>library.stop());return {root,library,options,directory:library.directory};
}
test('only completed nonempty MP4 files are listed, with real size and cached duration',async t=>{
    let probes=0;const f=await fixture(t,async()=>{probes++;return 12.5;});
    for(const name of ['a.mp4','b.MP4','c.mp4.part','c.mp4.part.retained-123','.hidden.mp4','empty.mp4','readme.txt'])await writeFile(path.join(f.directory,name),name==='empty.mp4'?'':'video-bytes');
    await mkdir(path.join(f.directory,'folder.mp4'));await writeFile(path.join(f.root,'outside.mp4'),'outside');await symlink(path.join(f.root,'outside.mp4'),path.join(f.directory,'link.mp4'));
    assert.deepEqual(await f.library.videos(),['a.mp4','b.MP4'].map(filename=>({filename,type:'original',size:11,duration:12.5,isLive:false})));
    await f.library.refresh();assert.equal(probes,2,'unchanged files are not probed on every poll');
    await f.library.stop();const resumed=new MP4Library(f.directory,f.options);t.after(()=>resumed.stop());
    assert.equal((await resumed.videos()).length,2);assert.equal(probes,2,'restart reuses stat-matched duration cache');
});
test('atomic publication, file changes and manual deletion arrive through the revision feed',async t=>{
    const f=await fixture(t);const first=await f.library.changes(undefined,undefined);
    const waiting=f.library.changes(first.revision,first.epoch,5000);
    const part=path.join(f.directory,'new.mp4.part');await writeFile(part,'a retained partial');
    await f.library.refresh();assert.deepEqual(await f.library.videos(),[]);
    await rename(part,path.join(f.directory,'new.mp4'));const published=await waiting;
    assert.ok(published.changes.some(c=>c.item?.filename==='new.mp4'));
    await writeFile(path.join(f.directory,'new.mp4'),'changed bytes');await f.library.refresh();
    const changed=await f.library.changes(published.revision,first.epoch);assert.equal(changed.changes.at(-1).item.size,13);
    await rm(path.join(f.directory,'new.mp4'));await f.library.refresh();
    const removed=await f.library.changes(changed.revision,first.epoch);assert.deepEqual(removed.changes.at(-1).removed,{filename:'new.mp4',type:'original'});
    assert.deepEqual((await f.library.changes(undefined,'old epoch')).videos,[]);
});
test('client disconnect and service shutdown release waiting long polls',async t=>{
    const f=await fixture(t);const initial=await f.library.changes(undefined,undefined);
    const abort=new AbortController();const waiting=f.library.changes(initial.revision,initial.epoch,25000,abort.signal);abort.abort();await waiting;
    const shutdown=f.library.changes(initial.revision,initial.epoch,25000);await new Promise(r=>setImmediate(r));await f.library.stop();await shutdown;
});
test('recreating the media directory reattaches its publication watcher',async t=>{
    const f=await fixture(t);await f.library.videos();
    await rm(f.directory,{recursive:true});await f.library.refresh();await mkdir(f.directory);await f.library.refresh();
    const before=await f.library.changes(undefined,undefined);
    const waiting=f.library.changes(before.revision,before.epoch,800);
    await writeFile(path.join(f.directory,'after.mp4'),'published bytes');
    const after=await waiting;assert.ok(after.changes.some(c=>c.item?.filename==='after.mp4'),'directory restoration must not leave the old inode watcher attached');
});
test('a real temporary MP4 is probed without modifying its bytes',async t=>{
    const f=await fixture(t);const file=path.join(f.directory,'tiny.mp4');
    await execute('ffmpeg',['-v','error','-f','lavfi','-i','color=c=black:s=16x16:r=1','-t','2','-an','-c:v','libx264','-movflags','+faststart',file]);
    const before=await readFile(file);const library=new MP4Library(f.directory,{stateFile:path.join(f.root,'real-index.json')});t.after(()=>library.stop());
    const [video]=await library.videos();assert.equal(video.duration,2);assert.equal(video.size,before.length);assert.deepEqual(await readFile(file),before);
});
test('MP4 routes stream byte ranges and HEAD for seeking; partials, symlinks and traversal stay private',async t=>{
    const f=await fixture(t);const bytes=Buffer.alloc(4096);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
    const name='file #1?%.mp4';await writeFile(path.join(f.directory,name),bytes);await writeFile(path.join(f.directory,'unfinished.mp4.part'),'partial');
    await writeFile(path.join(f.root,'outside.mp4'),'private');await symlink(path.join(f.root,'outside.mp4'),path.join(f.directory,'link.mp4'));
    const app=express();app.use(createBunkrLibraryRoutes(f.library));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
    const base=`http://127.0.0.1:${server.address().port}`,url=base+'/media/bunkr/'+encodeURIComponent(name);
    const first=await fetch(url,{headers:{Range:'bytes=100-199'}});assert.equal(first.status,206);assert.equal(first.headers.get('content-type'),'video/mp4');assert.equal(first.headers.get('content-range'),'bytes 100-199/4096');assert.deepEqual(Buffer.from(await first.arrayBuffer()),bytes.subarray(100,200));
    const head=await fetch(url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),'4096');assert.equal((await head.arrayBuffer()).byteLength,0);
    const tail=await fetch(url,{headers:{Range:'bytes=-32'}});assert.equal(tail.status,206);assert.deepEqual(Buffer.from(await tail.arrayBuffer()),bytes.subarray(-32));
    const unsatisfied=await fetch(url,{headers:{Range:'bytes=9999-'}});assert.equal(unsatisfied.status,416);assert.equal(unsatisfied.headers.get('content-range'),'bytes */4096');
    const conditional=await fetch(url,{headers:{Range:'bytes=0-7','If-Range':head.headers.get('etag')}});assert.equal(conditional.status,206);assert.deepEqual(Buffer.from(await conditional.arrayBuffer()),bytes.subarray(0,8));
    const replaced=await fetch(url,{headers:{Range:'bytes=0-7','If-Range':'"old-entity"'}});assert.equal(replaced.status,200);assert.deepEqual(Buffer.from(await replaced.arrayBuffer()),bytes);
    for(const name of ['unfinished.mp4.part','link.mp4','../outside.mp4','.private.mp4'])assert.equal((await fetch(base+'/media/bunkr/'+encodeURIComponent(name))).status,404);
    assert.equal((await fetch(base+'/api/videos?provider=tango')).status,400);
    const rows=await(await fetch(base+'/api/videos?provider=bunkr')).json();assert.equal(rows[0].filename,name);
    const feed=await(await fetch(base+'/api/videos/changes?provider=bunkr')).json();assert.equal(feed.videos[0].size,4096);
    assert.deepEqual((await readdir(f.directory)).sort(),[name,'link.mp4','unfinished.mp4.part'].sort(),'listing and playback never move or rewrite media');
});
