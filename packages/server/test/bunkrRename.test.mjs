import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import {MP4Library} from '../dist/services/video/mp4Library.js';
import {MP4RenameError,mp4RenameName} from '../dist/services/video/mp4Identity.js';
import {createBunkrLibraryRoutes} from '../dist/api/bunkr-library.routes.js';
import {BunkrDownloads} from '../dist/services/bunkrDownload.js';
async function fixture(t,hooks){
    const root=await mkdtemp(path.join(os.tmpdir(),'bunkr-rename-'));const directory=path.join(root,'media');await mkdir(directory);
    t.after(()=>rm(root,{recursive:true,force:true}));
    const options={stateFile:path.join(root,'state/index.json'),probe:async()=>20,renameHooks:hooks};
    const library=new MP4Library(directory,options);t.after(()=>library.stop());
    const bytes=Buffer.from('original media bytes are unchanged');await writeFile(path.join(directory,'original.mp4'),bytes);
    return {root,directory,library,options,bytes};
}
test('names preserve MP4, support Unicode and reject unsafe paths and oversized byte names',()=>{
    assert.equal(mp4RenameName(' My video '),'My video.mp4');assert.equal(mp4RenameName('My video.MP4'),'My video.MP4');assert.equal(mp4RenameName('cafe\u0301'),'café.mp4');
    for(const value of ['',null,'../outside','x/y','x\\y','.hidden','x\ny','🎬'.repeat(100)])assert.throws(()=>mp4RenameName(value),MP4RenameError);
});
test('rename preserves bytes, identity, old playback URLs and progress keys across restart',async t=>{
    const f=await fixture(t);const [original]=await f.library.videos();
    const after=await f.library.renameFile(original.fileId,original.filename,'New #name?%');
    assert.equal(after.filename,'New #name?%.mp4');assert.equal(after.fileId,original.fileId);assert.equal(after.size,original.size);
    assert.deepEqual(await readdir(f.directory),[after.filename]);assert.deepEqual(await readFile(await f.library.fileById(original.fileId)),f.bytes);
    assert.equal(await f.library.file(original.filename),path.join(f.directory,after.filename));
    assert.equal((await f.library.renameFile(original.fileId,original.filename,'New #name?%')).filename,after.filename,'lost acknowledgements retry idempotently');
    await f.library.stop();const restarted=new MP4Library(f.directory,f.options);t.after(()=>restarted.stop());
    assert.equal((await restarted.videos())[0].fileId,original.fileId);assert.equal(await restarted.file(original.filename),path.join(f.directory,after.filename));
});
test('renaming WebM and MKV preserves their original container through restart',async t=>{
    const f=await fixture(t);await rm(path.join(f.directory,'original.mp4'));
    for(const extension of ['mkv','webm'])await writeFile(path.join(f.directory,'original.'+extension),f.bytes);
    const original=await f.library.videos();
    for(const video of original){
        const extension=path.extname(video.filename);
        const renamed=await f.library.renameFile(video.fileId,video.filename,'New title');
        assert.equal(renamed.filename,'New title'+extension);assert.equal(renamed.fileId,video.fileId);
    }
    await f.library.stop();const restarted=new MP4Library(f.directory,f.options);t.after(()=>restarted.stop());
    for(const video of original){assert.deepEqual(await readFile(await restarted.file(video.filename)),f.bytes);}
});
test('collisions and stale filenames never overwrite or rename another video',async t=>{
    const f=await fixture(t);await writeFile(path.join(f.directory,'occupied.mp4'),'other media');const original=(await f.library.videos()).find(row=>row.filename==='original.mp4');
    await assert.rejects(f.library.renameFile(original.fileId,original.filename,'occupied'),e=>e.status===409);
    assert.equal(await readFile(path.join(f.directory,'occupied.mp4'),'utf8'),'other media');assert.deepEqual(await readFile(path.join(f.directory,original.filename)),f.bytes);
    await f.library.renameFile(original.fileId,original.filename,'renamed');
    await assert.rejects(f.library.renameFile(original.fileId,original.filename,'stale request'),e=>e.status===409);
    assert.equal((await f.library.videos()).length,2,'a rejected request cannot poison subsequent library scans');
});
test('an interrupted metadata handoff finishes the durable rename on restart',async t=>{
    let fail=true,jobName='original.mp4';const hooks={prepare:async()=>['job'],commit:async change=>{jobName=change.to;if(fail){fail=false;throw new Error('fixture process interrupted');}}};
    const f=await fixture(t,hooks);const [before]=await f.library.videos();
    await assert.rejects(f.library.renameFile(before.fileId,before.filename,'after crash'),/interrupted/);
    const journal=JSON.parse(await readFile(path.join(f.root,'state/rename-journal.json'),'utf8'));assert.equal(journal.stage,'linked');
    await f.library.stop();const recovered=new MP4Library(f.directory,f.options);t.after(()=>recovered.stop());
    const [after]=await recovered.videos();assert.equal(after.filename,'after crash.mp4');assert.equal(after.fileId,before.fileId);assert.equal(jobName,after.filename);
    assert.deepEqual(await readFile(path.join(f.directory,after.filename)),f.bytes);assert.deepEqual(await readdir(f.directory),[after.filename]);
});
test('a user deletion during an interrupted rename is never recreated',async t=>{
    let fail=true,jobName='original.mp4';const hooks={prepare:async()=>['job'],commit:async change=>{jobName=change.to;if(fail){fail=false;throw new Error('interrupted');}}};
    const f=await fixture(t,hooks);const [before]=await f.library.videos();await assert.rejects(f.library.renameFile(before.fileId,before.filename,'deleted target'));
    await f.library.stop();await rm(path.join(f.directory,'deleted target.mp4'));
    const recovered=new MP4Library(f.directory,f.options);t.after(()=>recovered.stop());const [after]=await recovered.videos();
    assert.equal(after.filename,'original.mp4');assert.equal(jobName,'original.mp4');assert.deepEqual(await readdir(f.directory),['original.mp4']);
});
test('native rename endpoint is scoped, idempotent and keeps byte-range playback alive',async t=>{
    const f=await fixture(t);const [video]=await f.library.videos();const app=express();app.use(express.json());app.use(createBunkrLibraryRoutes(f.library));
    const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
    const base=`http://127.0.0.1:${server.address().port}`,endpoint=base+`/api/bunkr/files/${video.fileId}/rename`;
    const send=headers=>fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({filename:video.filename,name:'Phone rename'})});
    assert.equal((await send({})).status,403);assert.equal((await send({'X-Video-Library':'1',Origin:'https://bunkr.cr'})).status,403);
    const response=await send({'X-Video-Library':'1'});assert.equal(response.status,200);assert.equal((await response.json()).video.filename,'Phone rename.mp4');
    const stream=await fetch(base+`/media/bunkr/id/${video.fileId}`,{headers:{Range:'bytes=0-7'}});assert.equal(stream.status,206);assert.deepEqual(Buffer.from(await stream.arrayBuffer()),f.bytes.subarray(0,8));
    const legacy=await fetch(base+'/media/bunkr/'+encodeURIComponent(video.filename),{headers:{Range:'bytes=2-9'}});assert.equal(legacy.status,206);assert.deepEqual(Buffer.from(await legacy.arrayBuffer()),f.bytes.subarray(2,10));
    assert.equal((await(await fetch(base+`/api/bunkr/files/${video.fileId}`)).json()).video.filename,'Phone rename.mp4');
});
test('a file already streaming remains byte-identical through a rename',async t=>{
    const f=await fixture(t);const bytes=Buffer.alloc(5*1024*1024,73);await writeFile(path.join(f.directory,'original.mp4'),bytes);
    const [video]=await f.library.videos();const app=express();app.use(createBunkrLibraryRoutes(f.library));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
    const response=await fetch(`http://127.0.0.1:${server.address().port}/media/bunkr/id/${video.fileId}`),reader=response.body.getReader();
    const first=await reader.read();const chunks=[Buffer.from(first.value)];
    await f.library.renameFile(video.fileId,video.filename,'Streaming continues');
    while(true){const part=await reader.read();if(part.done)break;chunks.push(Buffer.from(part.value));}
    assert.deepEqual(Buffer.concat(chunks),bytes);assert.deepEqual(await readFile(path.join(f.directory,'Streaming continues.mp4')),bytes);
});
for(const extension of ['mp4','mkv','webm'])test('completed '+extension+' download is listed and its receipt follows rename',async t=>{
    const f=await fixture(t);await rm(path.join(f.directory,'original.mp4'));
    const fetcher=async input=>{
        const url=new URL(input);
        if(url.pathname.startsWith('/f/'))return new Response('<a href="https://dl.bunkr.cr/file/42">Download</a>');
        if(url.pathname==='/api/_001_v2')return Response.json({mediafiles:'https://edge.cdn.cr',path:'/video.'+extension,original:'clip.'+extension});
        if(url.pathname==='/sign')return Response.json({token:'fixture',ex:123});
        return new Response(f.bytes,{headers:{'content-length':String(f.bytes.length),etag:'"same"'}});
    };
    const queue=new BunkrDownloads({directory:f.directory,stateDirectory:path.join(f.root,'queue'),fetcher,autoStart:false});t.after(()=>queue.stop());
    const job=await queue.enqueue('https://bunkr.cr/f/Fixture42');await queue.runPending();
    const hooks={prepare:(...args)=>queue.prepareLocalRename(...args),commit:change=>queue.commitLocalRename(change)};
    const library=new MP4Library(f.directory,{...f.options,renameHooks:hooks});t.after(()=>library.stop());
    const [before]=await library.videos();const renamed=await library.renameFile(before.fileId,before.filename,'My saved clip');
    const receipt=await queue.get(job.id);assert.equal(receipt.filename,renamed.filename);assert.equal(receipt.originalFilename,before.filename);assert.equal(receipt.fileId,before.fileId);assert.equal(receipt.state,'complete');
    assert.equal((await queue.enqueue('https://bunkr.ph/f/Fixture42')).id,job.id);assert.deepEqual(await readFile(path.join(f.directory,renamed.filename)),f.bytes);
});
