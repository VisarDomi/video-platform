// Run the actual native bundle with a deterministic bridge, never the real account.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {chromium} from '../../../manga/gallery-downloader/node_modules/playwright-core/index.mjs';
import {testMultipleVideos} from './multiple-videos.mjs';
for(const args of [[],['xvideos'],['invalid'],['tango','tango']]) {
    assert.notEqual(spawnSync('node',['scripts/build-ios.mjs',...args,'--prepare-only'],{encoding:'utf8'}).status,0);
}
assert.equal(spawnSync('node',['scripts/build-ios.mjs','tango','--prepare-only'],{stdio:'inherit'}).status,0);
const bundle=fs.readFileSync('apps/ios/build/tango/Web/app.js','utf8');
assert.ok(!bundle.includes('document.open('),'No website takeover in native bundle');
assert.ok(!bundle.includes('xvideos.com'),'Unselected provider is excluded');
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
try {
    const context=await browser.newContext({viewport:{width:428,height:800}});
    let checkpoint={},activeDocument='',cold=true;
    const requests=[];
    const actions=[];
    let listRevision=0;
    let enrichGate;
    const records=()=>[1,2,3].map(n=>({isPublic:true,anchor:{encryptedAccountId:'person-'+n,firstName:'Person '+n},stream:{id:'stream-'+n+'-'+listRevision,masterListUrl:'https://media.invalid/'+n+'.m3u8',status:'LIVING'}}));
    await context.exposeBinding('nativeBridge',async(_,message)=>{
        const {command,args={}}=message;
        if(command==='init') { activeDocument=args.document; const result={...checkpoint,cold};cold=false;return JSON.stringify(result); }
        if(command==='activate') { activeDocument=args.document;return '{}'; }
        if(command==='save') { if(activeDocument===args.document) checkpoint={...args};return '{}'; }
        if(command==='authenticate') return '{}';
        if(command==='media')return JSON.stringify({url:args.url,quality:''});
        if(command!=='request')throw new Error('Unknown command '+command);
        const url=new URL(args.url);requests.push(url.pathname);
        assert.match(args.headers?.Accept ?? '',/application\/json/,'Preserve JSON content negotiation');
        assert.ok(!url.pathname.includes('/refresh')&&!url.pathname.endsWith('/tokenData'),'Web documents must not own auth refresh');
        let data={};
        if(url.pathname.includes('/follow/')) {
            assert.equal(args.method,'POST');
            assert.match(args.body,/^person-\d$/);
            actions.push({action:url.pathname.endsWith('/add')?'follow':'unfollow',id:args.body});
        }
        else if(url.pathname.includes('blocklist') && args.method==='POST') {
            assert.equal(args.headers['Content-Type'],'application/json');
            const body=JSON.parse(args.body);
            assert.equal(body.action,'BLOCK');
            actions.push({action:'block',id:body.account_id[0]});
            data={error_code:0};
        }
        else if(url.port==='9999')data=[];
        else if(url.pathname.includes('blocklist'))data=[];
        else if(url.pathname.includes('following_recommendations'))data={records:records().slice(1)};
        else if(url.pathname.includes('/following'))data={records:records().slice(0,1)};
        else if(url.pathname.includes('/single')) { if(enrichGate) await enrichGate; data={basicProfile:{firstName:'Enriched'}}; }
        else if(url.pathname.endsWith('/watch'))data={};
        return JSON.stringify({status:200,text:JSON.stringify(data)});
    });
    await context.route('**/*',route=>{
        const url=new URL(route.request().url());
        if(url.hostname==='media.invalid')return route.abort();
        if(url.pathname==='/app.js')return route.fulfill({contentType:'application/javascript',body:bundle});
        return route.fulfill({contentType:'text/html',body:fs.readFileSync('apps/ios/web/index.html','utf8').replace('</head>','<style>.stream-row{min-height:400px}</style></head>')});
    });
    await context.addInitScript(()=>{
        window.webkit={messageHandlers:{viewer:{postMessage:message=>window.nativeBridge(message)}}};
        Object.defineProperties(HTMLVideoElement.prototype,{videoWidth:{get:()=>640},videoHeight:{get:()=>360}});
        const paused=new WeakMap();
        Object.defineProperty(HTMLMediaElement.prototype,'paused',{get(){return paused.get(this)??true;}});
        HTMLMediaElement.prototype.load=function(){paused.set(this,true);};
        HTMLMediaElement.prototype.pause=function(){paused.set(this,true);};
        HTMLMediaElement.prototype.play=async function(){paused.set(this,false);};
        const listen=HTMLMediaElement.prototype.addEventListener;
        HTMLMediaElement.prototype.addEventListener=function(type,...args){if(type!=='error')listen.call(this,type,...args);};
    });
    let page=await context.newPage();await page.goto('https://app.invalid/');
    await page.waitForFunction(()=>document.querySelectorAll('.stream-row').length===3);
    assert.deepEqual(await page.locator('.stream-row').evaluateAll(rows=>rows.map(r=>r.classList.contains('following'))),[true,false,false]);
    assert.equal(await page.locator('button').count(),0,'Home has no added native UI');
    const listRequests=()=>requests.filter(path=>path.includes('/recommendator/')).length;
    const initial=listRequests();
    await page.evaluate(async()=>{ scrollTo(0,200); await window.streamViewerApp.save(); });
    let releaseEnrichment;
    enrichGate=new Promise(resolve=>releaseEnrichment=resolve);
    await page.locator('.stream-row').nth(1).click();
    await page.waitForFunction(()=>document.querySelector('.stream-stage.viewer-loading'));
    await page.evaluate(()=>window.streamViewerApp.save());
    assert.equal(checkpoint.path,new URL(page.url()).pathname,'Reader destination survives a kill while profile/geometry is loading');
    enrichGate=undefined; releaseEnrichment();
    await page.waitForFunction(()=>document.querySelector('.stream-stage:not(.viewer-loading)'));
    assert.equal(listRequests(),initial,'Navigation retains the shared ordered list');
    await testMultipleVideos(page,async()=>{});
    const playback=await page.evaluate(()=>{
        const videos=[...document.querySelectorAll('video')];
        videos[0].pause(); videos[1].muted=false;
        const before=videos.map(v=>({paused:v.paused,muted:v.muted}));
        dispatchEvent(new Event('viewer-background'));
        const stopped=videos.every(v=>v.paused);
        dispatchEvent(new Event('viewer-foreground'));
        return {before,stopped,after:videos.map(v=>({paused:v.paused,muted:v.muted}))};
    });
    assert.ok(playback.stopped);
    assert.deepEqual(playback.after,playback.before,'Foreground preserves pause and mute choices');
    // Save selection before cold start; the refreshed session must resolve the
    // same streamer even if Tango has assigned them a different live stream ID.
    await page.evaluate(()=>window.streamViewerApp.save());
    const selected=checkpoint.currentStreamerId;
    const savedHomeY=checkpoint.homeY;
    assert.ok(savedHomeY>0,'Fixture starts from a scrolled Home');
    assert.ok(selected);
    checkpoint={...checkpoint,path:'/stream/old-live-id'};
    const saved={...checkpoint};
    await page.close();checkpoint=saved;cold=true;listRevision++;
    enrichGate=new Promise(resolve=>releaseEnrichment=resolve);
    page=await context.newPage();await page.goto('https://app.invalid/');
    await page.waitForURL('**/stream/*');
    await page.waitForFunction(()=>document.querySelector('.stream-stage.viewer-loading'));
    await page.evaluate(()=>window.streamViewerApp.save());
    assert.equal(checkpoint.currentStreamerId,selected,'Cold auto-navigation selects through the shared row before profile loading');
    enrichGate=undefined; releaseEnrichment();
    await page.waitForFunction(()=>document.querySelector('.stream-stage:not(.viewer-loading)'));
    assert.equal(checkpoint.currentStreamerId,selected,'Cold launch reanchors selected streamer');
    assert.match(page.url(),new RegExp('stream-'+selected.split('-')[1]+'-1$'));
    await page.goBack();
    await page.waitForFunction(()=>document.querySelectorAll('.stream-row').length===3);
    assert.equal(await page.locator('.stream-row.current').getAttribute('data-streamer-id'),selected);
    await page.waitForFunction(y=>Math.abs(scrollY-y)<2,savedHomeY);
    assert.equal(checkpoint.homeY,savedHomeY,'Cold reader preserves the Home position beneath it');
    // A late pagehide from the old document must not replace the current state.
    const current={...checkpoint};
    await page.evaluate(()=>window.nativeBridge({command:'save',args:{document:'stale',path:'/stream/stale'}}));
    assert.deepEqual(checkpoint,current);
    await page.locator('.stream-row').nth(1).click();
    await page.waitForFunction(()=>document.querySelector('.stream-stage:not(.viewer-loading)'));
    const follow=page.locator('.follow');
    await follow.click();
    await page.waitForFunction(()=>document.querySelector('.follow').classList.contains('remove'));
    await follow.click();
    await page.waitForFunction(()=>!document.querySelector('.follow').classList.contains('remove'));
    await follow.click();
    await page.waitForFunction(()=>document.querySelector('.follow').classList.contains('remove'));
    const count=actions.length;
    await page.locator('.block').click();
    assert.equal(actions.length,count,'First Block tap only asks for confirmation');
    await page.locator('.block').click();
    await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('stream-viewer-state')).streams.length===2);
    assert.deepEqual(actions.map(a=>a.action),['follow','unfollow','follow','unfollow','block']);
    assert.ok(actions.every(a=>a.id===actions[0].id),'Actions must target the selected streamer');
    assert.ok(await page.evaluate(id=>!JSON.parse(sessionStorage.getItem('stream-viewer-state')).streams.some(s=>s.streamerId===id),actions[0].id));
    await page.waitForFunction(()=>!document.querySelector('.follow').classList.contains('remove'));
    assert.equal(checkpoint.currentStreamerId,await page.evaluate(()=>JSON.parse(sessionStorage.getItem('stream-viewer-state')).currentStreamerId),'Async removal checkpoints the replacement without another gesture');
    console.log('PASS: checkpoints during delayed initial/cold reader load, async replacement, scrolled Home Back, and foreground pause/mute preservation.');
    console.log('PASS: Follow/unfollow UI, Block confirmation, unfollow before Block and removal from the reader.');
    console.log('PASS: required provider, unchanged home/reader, native auth boundary, Multi, cold stream reanchor, native-style Back and stale-save rejection.');
} finally {await browser.close();}
