import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { preparePorntrexTransfer, readPorntrexTransfer, PORNTREX_CHUNK_BYTES } from '../dist/upload/porntrexTransfer.js';
import { ChromiumPorntrexUploader } from '../dist/upload/chromiumPorntrexUploader.js';

// The actual site's contract: FormData slices, JSON acknowledgements, and an
// index-preserving retry when XHR status is zero. All traffic is intercepted.
async function fixture(t, { hangIndex, alwaysHang = false, delay = 0 } = {}) {
    const browser = await chromium.launch({ executablePath:'/usr/bin/chromium', headless:true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const source = Buffer.from(Array.from({length:6144}, (_,i)=>i%251));
    const indices = [], pieces = new Map(), observations = [];
    await page.route('**/*', async route => {
        const req = route.request();
        if (req.method() === 'GET') return route.fulfill({contentType:'text/html',body:`<!doctype html>
          <a>Hello, fixture</a><form class="form-upload"><input name="content" type="file">
          <div class="generic-error" style="height:1px"></div><div class="progressbar"><div class="text">0%</div></div></form>
          <input id="edit_video_title" hidden>
          <script>var pageContext={upload_chunk_size:209715200};
          window.startFixture=()=>{const file=new Blob([new Uint8Array(${JSON.stringify([...source])})]);
            const size=Number(pageContext.upload_chunk_size), chunks=Math.ceil(file.size/size);
            function send(index){const xhr=new XMLHttpRequest();xhr.open('POST','/upload-video/');
              xhr.onload=()=>{if(JSON.parse(xhr.responseText).status!=='success')return;
                if(index===0)document.querySelector('#edit_video_title').hidden=false;
                else send(index===chunks?0:index+1);};
              xhr.onerror=xhr.onabort=()=>setTimeout(()=>send(index),10);
              const body=new FormData();body.append('index',String(index));body.append('chunks',String(chunks));
              if(index)body.append('content',file.slice((index-1)*size,Math.min(index*size,file.size)),'fixture.mp4');
              xhr.send(body);
            }send(1);};</script>`});
        assert.equal(req.url(),'https://www.porntrex.com/upload-video/');
        const data=await new Request(req.url(),{method:'POST',headers:{'content-type':req.headers()['content-type']},body:req.postDataBuffer()}).formData();
        const index=Number(data.get('index'));indices.push(index);
        observations.push(await readPorntrexTransfer(page));
        if(index===hangIndex && (alwaysHang || indices.filter(i=>i===index).length===1))return;
        if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
        if(index)pieces.set(index,Buffer.from(await data.get('content').arrayBuffer()));
        await route.fulfill({contentType:'application/json',body:'{"status":"success","data":{}}'});
    });
    await page.goto('https://www.porntrex.com/upload-video/');
    return {page,source,indices,pieces,observations};
}

test('an unresponsive chunk is retried at its own index, preserving the accepted prefix and exact bytes',async t=>{
    const f=await fixture(t,{hangIndex:2});const claims=[];
    await preparePorntrexTransfer(f.page,f.source.length,async n=>claims.push(n),{chunkBytes:2048,idleMs:200});
    await f.page.evaluate(()=>startFixture());
    await f.page.locator('#edit_video_title').waitFor({state:'visible',timeout:5000});
    assert.deepEqual(f.indices,[1,2,2,3,0]);
    assert.deepEqual(Buffer.concat([...f.pieces.values()]),f.source);
    const state=await readPorntrexTransfer(f.page);
    assert.equal(state.abortedChunks,1);assert.equal(state.failure,null);
    assert.equal(await f.page.evaluate(()=>pageContext.upload_chunk_size),2048);
    assert(claims.length>0);assert.equal(claims.at(-1),state.claimedBytes);
    // A body cannot leave before its durable allowance callback completed.
    assert(f.observations.every(s=>s.claimedBytes>0));
});

test('repeatedly dead chunks stop after three attempts instead of retrying forever',async t=>{
    const f=await fixture(t,{hangIndex:2,alwaysHang:true});
    await preparePorntrexTransfer(f.page,f.source.length,async()=>{},{chunkBytes:2048,idleMs:100});
    await f.page.evaluate(()=>startFixture());
    await f.page.waitForFunction(()=>window.__pipelineTransfer.failure!==null,{},{timeout:5000});
    assert.deepEqual(f.indices,[1,2,2,2]);
    assert.match((await readPorntrexTransfer(f.page)).failure,/three attempts/);
    assert.equal(f.pieces.has(1),true);assert.equal(f.pieces.has(3),false);
});

test('slow chunk acknowledgements count as progress even when the integer percentage remains zero',async t=>{
    const f=await fixture(t,{delay:45});
    await preparePorntrexTransfer(f.page,f.source.length,async()=>{},{chunkBytes:2048,idleMs:1000});
    const uploader=new ChromiumPorntrexUploader({executablePath:'unused',profilePath:'unused'});
    await uploader.waitForFileTransfer(f.page,{onEvidence:async()=>{}},()=>f.page.evaluate(()=>startFixture()),{stallMs:100,pollMs:5});
    assert.equal(await f.page.locator('.progressbar .text').textContent(),'0%');
    assert.deepEqual(Buffer.concat([...f.pieces.values()]),f.source);
});

test('failed durable allowance prevents the chunk from being sent',async t=>{
    const f=await fixture(t);
    // First chunk claim exceeds this tiny full-file intent, forcing persistence.
    await preparePorntrexTransfer(f.page,1,async()=>{throw Error('temporary fixture disk failure');},{chunkBytes:2048,idleMs:100});
    await f.page.evaluate(()=>startFixture());
    await f.page.waitForFunction(()=>window.__pipelineTransfer.failure!==null);
    assert.deepEqual(f.indices,[]);
    assert.match((await readPorntrexTransfer(f.page)).failure,/persist/);
});

test('production chunk size is capped and impossible overhead is refused before any transfer',async t=>{
    const f=await fixture(t);
    await preparePorntrexTransfer(f.page,f.source.length,async()=>{});
    assert.equal(PORNTREX_CHUNK_BYTES,4*1024*1024);
    assert.equal(await f.page.evaluate(()=>pageContext.upload_chunk_size),PORNTREX_CHUNK_BYTES);
    const second=await fixture(t);
    await preparePorntrexTransfer(second.page,100_000,async()=>{},{chunkBytes:1});
    await second.page.evaluate(()=>startFixture());
    await second.page.waitForFunction(()=>window.__pipelineTransfer.failure!==null);
    assert.deepEqual(second.indices,[]);
    assert.match((await readPorntrexTransfer(second.page)).failure,/allowance exhausted/);
});
