import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium,webkit} from 'playwright-core';

const ASSETS=new URL('../../pipeline/dashboard/web/',import.meta.url);
const engines=[['Chromium',chromium,{executablePath:'/usr/bin/chromium'}],
 ['WebKit',webkit,{executablePath:process.env.WEBKIT_EXECUTABLE_PATH||'/home/visar/.cache/ms-playwright/webkit-2370/pw_run.sh'}]];

function fixture(){
 const now=new Date().toISOString();
 const service={state:'active',cpu_percent:.4,anonymous_bytes:70000000,uptime_seconds:3600};
 return {generated_at:now,fresh:true,campaign:{state:'running',resume_at:null,worker_heartbeat:now,step:null},
  health:{attention:0,historical_removals:9,alerts:[]},
  counts:{verified:123,ready:2,short_waiting:1,prepared_batches:1,confirming:1,capturing:1,submitted:7,receipts_verified:3,converted:8},
  active:{id:'2026-01-01 010000 fixture-active',alias:'fixture-active',provider:'tango',captured_at:'2026-01-01 010000',stage:'upload',state:'uploading',seconds:900,size_bytes:1000000000,started_at:now,reservation_month:'2026-11',progress:{acknowledged_bytes:250000000,total_bytes:1000000000,percent:25,bytes_per_second:500000,eta_seconds:1500,fresh:true,updated_at:now}},
  captures:[{alias:'fixture-capture',provider:'sc',segments:350,seconds:700,active:true}],finalization:{processing:0,completed24:6},
  queue:[{id:'2026-01-02 010000 fixture-next',alias:'fixture-next',provider:'tango',captured_at:'2026-01-02 010000',seconds:800,stage:'convert'},
    {id:'2026-01-03 010000 fixture-later',alias:'fixture-later',provider:'fc2',captured_at:'2026-01-03 010000',seconds:900,stage:'describe'}],
  confirmations:[{recording_id:'2026-01-01 020000 fixture-verify',alias:'fixture-verify',confirm_after:now,remote_id:'fixture-id'}],
  shorts:{waiting:[{id:'2026-01-02 030000 fixture-short',alias:'fixture-short',stage:'shorts',provider:'tango',seconds:30}],batches:[{id:'2026-01-03 040000 joined-fixture',alias:'fixture-joined',stage:'convert',provider:'sc',seconds:180,clips:3,orientation:'Portrait'}]},
  budget:{month:'2026-11',day:1,released:100000000000,spent:20000000000,reserved:1000000000,remaining:79000000000,monthly_limit:700000000000,next_release:'2026-11-11T00:00:00+01:00',next_amount:300000000000,releases:[{day:1,bytes:100000000000},{day:11,bytes:300000000000},{day:21,bytes:700000000000}]},
  history:Array.from({length:14},(_,i)=>({date:`2026-10-${String(19+i%13).padStart(2,'0')}`,submitted:i%5,verified:i%3})),
  activity:[{recording:'fixture',alias:'fixture-active',stage:'verify',at:now},{recording:'fixture-done',alias:'fixture-done',stage:'verified',at:now}],
  storage:{total:4000000000000,free:500000000000,inventory:{downloads:1900000000000,artifacts:300000000000,retained_trash:20000000000,desktop_staging:0},inventory_at:now},
  services:Object.fromEntries(['video-downloader','video-server','video-auth','video-pipeline','video-xvfb','video-bunkr-downloads'].map(n=>[n,{...service}])),
  monitoring:{cadence:'daily',last_check:now}};
}

async function start(t,engine,options){
 let data=fixture(),offline=false,requests=0;
 // Real loopback HTTP fixtures also exercise WebKit's service-worker network
 // path, which bypasses Playwright's page.route after a worker takes control.
 const files=new Set(['index.html','app.js','style.css','sw.js','manifest.webmanifest','icon.svg','icon-192.png','icon-512.png','apple-touch-icon.png']);
 const server=createServer(async(req,res)=>{
  const path=new globalThis.URL(req.url,'http://fixture').pathname;
  if(path==='/api/dashboard'){requests++;server.emit('api-request');if(offline){res.destroy();return;}res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({ok:true,snapshot:data}));return;}
  const file=path==='/'?'index.html':path.slice(1);if(!files.has(file)){res.writeHead(404);res.end();return;}
  const type=file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.png')?'image/png':'application/manifest+json';
  res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(await readFile(new globalThis.URL(file,ASSETS)));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const browser=await engine.launch({headless:true,...options});t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1,reducedMotion:'reduce'});
 const page=await context.newPage();page.setDefaultTimeout(8000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForFunction(()=>document.querySelector('#connection-label')?.textContent==='Live');
 return {page,context,errors,get requests(){return requests;},setData(value){data=value;},getData(){return data;},offline(value){offline=value;},nextRequest(){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('No foreground request')),5000);server.once('api-request',()=>{clearTimeout(timer);resolve();});});}};
}

for(const [name,engine,options] of engines){
 test(`${name}: phone layout, stage navigation and safe text rendering`,async t=>{
  const f=await start(t,engine,options),p=f.page;
  for(const width of [320,390,430,1024]){await p.setViewportSize({width,height:844});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`no overflow at ${width}`);}
  await p.setViewportSize({width:390,height:844});
  assert.equal(await p.locator('.stat strong').first().innerText(),'123');assert.equal(await p.locator('#progress-number').innerText(),'25.0%');
  await p.getByRole('button',{name:/Queue$/}).click();await p.locator('#queue-search').fill('fixture-next');assert.equal(await p.locator('.queue-row').count(),1);
  await p.locator('.brand').click();assert.equal(await p.locator('#overview').isVisible(),true);
  await p.locator('#show-shorts').click();assert.match(await p.locator('#queue-list').innerText(),/fixture-short/);
  const changed=f.getData();changed.active.alias='<img src=x onerror="window.__unsafe=1">';f.setData(changed);await p.locator('#refresh').click();await p.waitForFunction(()=>document.querySelector('#now-alias').textContent.startsWith('<img'));
  assert.equal(await p.evaluate(()=>window.__unsafe),undefined);assert.equal(await p.locator('#now-alias img').count(),0);
  assert.deepEqual(f.errors,[]);
 });
 test(`${name}: offline reload preserves a clearly saved snapshot and reconnects`,async t=>{
  const f=await start(t,engine,options),p=f.page;
  await p.evaluate(()=>navigator.serviceWorker.ready);await p.waitForFunction(()=>navigator.serviceWorker.controller!==null);
  f.offline(true);await f.context.setOffline(true);await p.reload({waitUntil:'domcontentloaded'});
  await p.waitForFunction(()=>document.querySelector('#connection-label')?.textContent==='Saved');
  assert.equal(await p.locator('.stat strong').first().innerText(),'123');assert.match(await p.locator('#now-state').innerText(),/LAST SEEN/);assert.match(await p.locator('#health-label').innerText(),/Last known/);
  const changed=f.getData();changed.active.progress.percent=50;changed.active.progress.acknowledged_bytes=500000000;f.setData(changed);f.offline(false);await f.context.setOffline(false);await p.evaluate(()=>window.dispatchEvent(new Event('online')));
  await p.waitForFunction(()=>document.querySelector('#connection-label').textContent==='Live'&&document.querySelector('#progress-number').textContent==='50.0%');
  assert.deepEqual(f.errors,[]);
 });
 test(`${name}: hidden pages stop polling and resume immediately`,async t=>{
  const f=await start(t,engine,options),p=f.page;
  await p.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
  const before=f.requests;await new Promise(resolve=>setTimeout(resolve,6100));assert.equal(f.requests,before);
  const next=f.nextRequest();await p.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'));});
  await next;assert(f.requests>before);
 });
 test(`${name}: manual pause keeps capture visible without a fake active upload`,async t=>{
  const f=await start(t,engine,options),p=f.page;const changed=f.getData();changed.campaign.state='user_paused';changed.services['video-pipeline'].state='inactive';f.setData(changed);await p.locator('#refresh').click();
  await p.waitForFunction(()=>document.querySelector('#health-label').textContent==='Paused by you');
  assert.equal(await p.locator('#attention').isVisible(),false);
  const upload=p.locator('.pipe-node').filter({has:p.locator('.node-label',{hasText:'Upload'})});assert.equal(await upload.locator('strong').innerText(),'0');assert.equal(await upload.evaluate(n=>n.classList.contains('active')),false);
  assert.equal(await p.locator('#capture-strip').getByText('fixture-capture').isVisible(),true);
  assert.equal(await p.locator('#now-card').evaluate(n=>n.classList.contains('paused')),true);
 });
}
