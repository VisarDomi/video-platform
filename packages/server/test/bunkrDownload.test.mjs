import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { BunkrDownloads, bunkrPage, resolveBunkr } from '../dist/services/bunkrDownload.js';
import { createBunkrRoutes } from '../dist/api/bunkr.routes.js';

const page='https://bunkr.cr/f/Fixture42';
function fixture(media, metadata={}) {
    return async(input,init={})=>{
        const url=new URL(input);
        if(url.pathname==='/f/Fixture42')return new Response('<a href="https://dl.bunkr.cr/file/42">Download</a>');
        if(url.pathname==='/api/_001_v2'){
            assert.deepEqual(JSON.parse(init.body),{id:'42'});
            return Response.json({mediafiles:'https://edge.cdn.cr',path:'/storage/media/test.mp4',original:'../../clip.mp4',...metadata});
        }
        if(url.pathname==='/sign')return Response.json({token:'fixture',ex:12345});
        assert.equal(url.hostname,'edge.cdn.cr');
        assert.equal(url.searchParams.get('token'),'fixture');
        return media(url,init);
    };
}
async function queue(t,fetcher){
    const root=await mkdtemp(path.join(os.tmpdir(),'bunkr-test-'));
    const options={directory:path.join(root,'videos'),stateDirectory:path.join(root,'state'),fetcher,autoStart:false};
    const queue=new BunkrDownloads(options);t.after(()=>queue.stop());
    // Leave fixture lifetime to the test runner; no production folders are used.
    t.after(async()=>{const {rm}=await import('node:fs/promises');await rm(root,{recursive:true,force:true});});
    return {queue,options};
}
test('only the three HTTPS file-page domains are accepted; metadata cannot redirect to LAN or arbitrary hosts',async()=>{
    for(const domain of ['si','ph','cr'])assert.equal(bunkrPage(`https://bunkr.${domain}/f/abc/?x=1`).href,`https://bunkr.${domain}/f/abc`);
    for(const url of ['http://bunkr.cr/f/a','https://bunkr.cr.evil/f/a','https://bunkr.cr:9999/f/a','https://a@bunkr.cr/f/a','https://bunkr.cr/a/a'])assert.throws(()=>bunkrPage(url));
    await assert.rejects(resolveBunkr(page,fixture(()=>assert.fail(),{mediafiles:'http://127.0.0.1'})),/Unsupported/);
    await assert.rejects(resolveBunkr(page,fixture(()=>assert.fail(),{original:'page.html'})),/not a video/);
    const redirect=async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}});
    await assert.rejects(resolveBunkr(page,redirect),/Unsupported/);
});
test('queued clicks deduplicate across domains, stream once, and publish only a complete safe filename',async t=>{
    let transfers=0;
    const {queue:q,options}=await queue(t,fixture(()=>{transfers++;return new Response('video-bytes',{headers:{'content-type':'video/mp4','content-length':'11',etag:'"one"'}});}));
    const job=await q.enqueue(page);
    assert.equal((await q.enqueue(page.replace('.cr','.si'))).id,job.id);
    await q.runPending();
    const done=await q.get(job.id);assert.equal(done.state,'complete');assert.equal(done.bytes,11);assert.equal(transfers,1);
    assert.equal(await readFile(path.join(options.directory,done.filename),'utf8'),'video-bytes');
    assert.equal(path.basename(done.filename),done.filename);
    assert.ok(!(await readdir(options.directory)).some(name=>name.endsWith('.part')));
    const recovered=new BunkrDownloads(options);t.after(()=>recovered.stop());
    assert.equal((await recovered.enqueue(page)).state,'complete');await recovered.runPending();assert.equal(transfers,1);
});
test('a worker wake and duplicate tap cannot outrun the durable admission write',async t=>{
    let transfers=0,release,entered;
    const gate=new Promise(resolve=>{release=resolve;}),saving=new Promise(resolve=>{entered=resolve;});
    const {queue:q}=await queue(t,fixture(()=>{transfers++;return new Response('data',{headers:{'content-length':'4',etag:'"same"'}});}));
    const save=q.save.bind(q);let first=true;
    q.save=async job=>{if(first){first=false;entered();await gate;}return save(job);};
    const admission=q.enqueue(page);await saving;
    let duplicateSettled=false;const duplicate=q.enqueue(page).then(job=>{duplicateSettled=true;return job;});
    const wake=q.runPending();await new Promise(resolve=>setTimeout(resolve,30));
    const earlyTransfers=transfers,earlyAcknowledgement=duplicateSettled;release();
    const [a,b]=await Promise.all([admission,duplicate]);assert.equal(a.id,b.id);await wake;await q.runPending();assert.equal(transfers,1);
    assert.equal(earlyTransfers,0,'no media request before durable queue acceptance');assert.equal(earlyAcknowledgement,false,'duplicate tap waits for the original receipt');
});
test('interrupted transfers retain bytes and resume the identical entity after a service restart',async t=>{
    const body='abcdefghij';let interrupted=true,ranges=[];
    const fetcher=fixture((_url,init)=>{
        ranges.push(init.headers.Range);
        if(interrupted){interrupted=false;let reads=0;return new Response(new ReadableStream({async pull(controller){if(reads++===0)controller.enqueue(new TextEncoder().encode('abcd'));else {await new Promise(r=>setTimeout(r,30));controller.error(new Error('fixture connection lost'));}}}),{headers:{'content-length':'10',etag:'"same"'}});}
        assert.equal(init.headers['If-Range'],'"same"');
        return new Response(body.slice(4),{status:206,headers:{'content-length':'6','content-range':'bytes 4-9/10',etag:'"same"'}});
    });
    const {queue:q,options}=await queue(t,fetcher);const job=await q.enqueue(page);await q.runPending();
    const saved=await q.get(job.id);assert.equal(saved.state,'queued');assert.equal(await readFile(path.join(options.directory,saved.filename+'.part'),'utf8'),'abcd');
    q.stop();saved.retryAt=0;await writeFile(path.join(options.stateDirectory,job.id+'.json'),JSON.stringify(saved));
    const recovered=new BunkrDownloads(options);t.after(()=>recovered.stop());await recovered.runPending();
    assert.equal((await recovered.get(job.id)).state,'complete');assert.equal(await readFile(path.join(options.directory,saved.filename),'utf8'),body);
    assert.deepEqual(ranges,[undefined,'bytes=4-']);
});
test('unsupported resume preserves partial bytes and restarts without appending a different entity',async t=>{
    const {queue:q,options}=await queue(t,fixture(()=>new Response('new-video',{headers:{'content-length':'9',etag:'"changed"'}})));
    const job=await q.enqueue(page);job.filename='Fixture42 - clip.mp4';job.etag='"old"';job.total=12;job.state='downloading';job.durableBytes=3;
    const {mkdir}=await import('node:fs/promises');await mkdir(options.directory);await writeFile(path.join(options.directory,job.filename+'.part'),'old');
    await writeFile(path.join(options.stateDirectory,job.id+'.json'),JSON.stringify(job));
    const recovered=new BunkrDownloads(options);t.after(()=>recovered.stop());await recovered.runPending();
    assert.equal((await recovered.get(job.id)).state,'complete');
    const retained=(await readdir(options.directory)).find(n=>n.includes('.retained-'));assert.equal(await readFile(path.join(options.directory,retained),'utf8'),'old');
    assert.equal(await readFile(path.join(options.directory,job.filename),'utf8'),'new-video');
});
test('power-loss recovery preserves an uncommitted tail and resumes from the last fsynced checkpoint',async t=>{
    const {queue:q,options}=await queue(t,fixture((_url,init)=>{
        assert.equal(init.headers.Range,'bytes=4-');
        return new Response('efghij',{status:206,headers:{'content-length':'6','content-range':'bytes 4-9/10',etag:'"same"'}});
    }));
    const job=await q.enqueue(page);job.filename='Fixture42 - clip.mp4';job.etag='"same"';job.total=10;job.state='downloading';job.bytes=8;job.durableBytes=4;
    const {mkdir}=await import('node:fs/promises');await mkdir(options.directory);await writeFile(path.join(options.directory,job.filename+'.part'),'abcdBAD!');
    await writeFile(path.join(options.stateDirectory,job.id+'.json'),JSON.stringify(job));q.stop();
    const recovered=new BunkrDownloads(options);t.after(()=>recovered.stop());await recovered.runPending();
    assert.equal((await recovered.get(job.id)).state,'complete');assert.equal(await readFile(path.join(options.directory,job.filename),'utf8'),'abcdefghij');
    const tail=(await readdir(options.directory)).find(n=>n.includes('.retained-tail-'));assert.equal(await readFile(path.join(options.directory,tail),'utf8'),'BAD!');
});
test('a crash after the last durable byte recovers by HEAD without downloading or appending again',async t=>{
    const {queue:q,options}=await queue(t,fixture((_url,init)=>{
        assert.equal(init.method,'HEAD');return new Response(null,{headers:{'content-length':'4',etag:'"same"'}});
    }));
    const job=await q.enqueue(page);Object.assign(job,{filename:'Fixture42 - clip.mp4',etag:'"same"',total:4,bytes:4,durableBytes:4,state:'downloading'});
    const {mkdir}=await import('node:fs/promises');await mkdir(options.directory);await writeFile(path.join(options.directory,job.filename+'.part'),'done');
    await writeFile(path.join(options.stateDirectory,job.id+'.json'),JSON.stringify(job));q.stop();
    const recovered=new BunkrDownloads(options);t.after(()=>recovered.stop());await recovered.runPending();
    assert.equal((await recovered.get(job.id)).state,'complete');assert.deepEqual(await readdir(options.directory),[job.filename]);
});
test('a crash after atomic publication rejoins the complete file and removes only its identical partial link',async t=>{
    const {queue:q,options}=await queue(t,fixture(()=>assert.fail('already published; no media transfer needed')));
    const job=await q.enqueue(page);Object.assign(job,{filename:'Fixture42 - clip.mp4',etag:'"same"',total:4,bytes:4,durableBytes:4,state:'downloading'});
    const {mkdir,link}=await import('node:fs/promises');await mkdir(options.directory);
    const complete=path.join(options.directory,job.filename);await writeFile(complete,'done');await link(complete,complete+'.part');
    await writeFile(path.join(options.stateDirectory,job.id+'.json'),JSON.stringify(job));q.stop();
    const recovered=new BunkrDownloads(options);t.after(()=>recovered.stop());await recovered.runPending();
    assert.equal((await recovered.get(job.id)).state,'complete');assert.deepEqual(await readdir(options.directory),[job.filename]);
});
test('the accepted FIFO order survives restarting from receipt files named by hashes',async t=>{
    const {queue:q,options}=await queue(t,fixture(()=>assert.fail()));
    const first=await q.enqueue('https://bunkr.cr/f/oldest'),second=await q.enqueue('https://bunkr.cr/f/newest');
    first.createdAt='2026-01-01T00:00:00.000Z';second.createdAt='2026-02-01T00:00:00.000Z';
    for(const job of [second,first])await writeFile(path.join(options.stateDirectory,job.id+'.json'),JSON.stringify(job));q.stop();
    const recovered=new BunkrDownloads(options);t.after(()=>recovered.stop());const order=[];
    recovered.transfer=async job=>{order.push(job.page);};await recovered.runPending();
    assert.deepEqual(order,[first.page,second.page]);
});
test('SIGKILL during a real queued transfer recovers its durable prefix and completes exactly once',async t=>{
    const size=10*1024*1024;
    const {queue:q,options}=await queue(t,fixture((_url,init)=>{
        assert.equal(init.headers.Range,`bytes=${8*1024*1024}-`);
        return new Response(Buffer.alloc(2*1024*1024,97),{status:206,headers:{'content-length':String(2*1024*1024),'content-range':`bytes ${8*1024*1024}-${size-1}/${size}`,etag:'"same"'}});
    }));
    await q.get('');q.stop();
    const child=spawn(process.execPath,[new URL('./fixtures/bunkr-crash.mjs',import.meta.url).pathname,JSON.stringify(options)],{stdio:['ignore','pipe','pipe']});
    t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
    let log='',error='';child.stderr.on('data',chunk=>{error+=chunk;});
    await new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(new Error('crash fixture timed out: '+error)),8000);
        child.stdout.on('data',chunk=>{log+=chunk;if(log.includes('STREAMING')){clearTimeout(timeout);resolve();}});
        child.once('error',reject);child.once('exit',code=>{if(code!==null)reject(new Error('crash fixture exited: '+error));});
    });
    assert.ok(log.includes('ACCEPTED'));
    const files=(await readdir(options.stateDirectory)).filter(n=>n.endsWith('.json'));
    const saved=JSON.parse(await readFile(path.join(options.stateDirectory,files[0]),'utf8'));
    assert.equal(saved.durableBytes,8*1024*1024);
    const exited=once(child,'exit');child.kill('SIGKILL');await exited;
    const recovered=new BunkrDownloads(options);t.after(()=>recovered.stop());await recovered.runPending();
    const done=await recovered.get(saved.id);assert.equal(done.state,'complete');
    assert.deepEqual(await readFile(path.join(options.directory,done.filename)),Buffer.alloc(size,97));
    assert.ok((await readdir(options.directory)).some(n=>n.includes('.retained-tail-')));
});
test('HTML errors and length mismatches never publish a completed video',async t=>{
    for(const [body,type,length] of [['page','text/html',4],['short','video/mp4',10]]){
        const {queue:q,options}=await queue(t,fixture(()=>new Response(body,{headers:{'content-length':String(length),'content-type':type}})));
        const job=await q.enqueue(page);await q.runPending();assert.equal((await q.get(job.id)).state,'queued');
        assert.ok(!(await readdir(options.directory)).some(n=>n.endsWith('.mp4')));
    }
});
test('routes expose a no-cache capability and require an extension handoff before durable acceptance',async t=>{
    const {queue:q}=await queue(t,fixture(()=>assert.fail()));const app=express();app.use(express.json());app.use(createBunkrRoutes(q));
    const server=app.listen(0,'127.0.0.1');t.after(()=>new Promise(resolve=>server.close(resolve)));await new Promise(r=>server.once('listening',r));
    const base=`http://127.0.0.1:${server.address().port}/api/bunkr`;
    const health=await fetch(base+'/health');assert.equal(health.headers.get('cache-control'),'no-store');assert.equal((await health.json()).service,'video-platform-bunkr');
    const send=(url,headers={})=>fetch(base+'/downloads',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({url})});
    assert.equal((await send(page)).status,403);
    assert.equal((await send(page,{'X-Video-Download':'1',Origin:'https://bunkr.cr'})).status,403);
    assert.equal((await send('https://evil/f/a',{'X-Video-Download':'1'})).status,400);
    const response=await send(page,{'X-Video-Download':'1',Origin:'safari-web-extension://fixture'});assert.equal(response.status,202);
    const job=await response.json();assert.equal((await(await fetch(base+'/downloads/'+job.id)).json()).state,'queued');
    assert.equal((await fetch(base+'/downloads/unknown')).status,404);
});
