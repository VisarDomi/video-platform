// Full production extension bundle with controlled provider/media boundaries.
// This checks behavior/port parity; actual document-start and HLS need iOS Safari.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { testScrollSettlement } from './scroll-settlement.mjs';
import { chromium } from '../../../manga/gallery-downloader/node_modules/playwright-core/index.mjs';
const bundle=fs.readFileSync('dist/extension/content.js','utf8');
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
try {
    const context=await browser.newContext({viewport:{width:428,height:800}});
    const requests=[];
    const records=[1,2,3].map(n=>({isPublic:true,anchor:{encryptedAccountId:'person-'+n,firstName:'Person '+n},stream:{id:'stream-'+n,masterListUrl:'https://media.invalid/'+n+'.m3u8',status:'LIVING'}}));
    await context.route('**/*',async route=>{
        const url=new URL(route.request().url());
        requests.push(url.pathname);
        const headers={'Access-Control-Allow-Origin':'https://www.tango.me','Access-Control-Allow-Credentials':'true','Access-Control-Allow-Headers':'Content-Type,Accept','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};
        if(route.request().method()==='OPTIONS')return route.fulfill({status:204,headers});
        if(url.hostname==='gateway.tango.me'){
            let data={};
            if(url.pathname.includes('blocklist'))data=[];
            else if(url.pathname.includes('following_recommendations'))data={records:records.slice(1)};
            else if(url.pathname.includes('/following'))data={records:records.slice(0,1)};
            else if(url.pathname.includes('/single'))data={basicProfile:{firstName:'Enriched'}};
            return route.fulfill({headers,json:data});
        }
        if(url.port==='9999')return route.fulfill({headers,json:[]});
        if(url.hostname==='media.invalid')return route.abort();
        return route.fulfill({contentType:'text/html',body:'<!doctype html><p id="original">Original</p>'});
    });
    await context.addInitScript(()=>{
        if(location.hostname!=='www.tango.me')return;
        localStorage.setItem('latest_account_id','fixture-account');
        sessionStorage.setItem('username','fixture-session');
        Object.defineProperties(HTMLVideoElement.prototype,{videoWidth:{get:()=>640},videoHeight:{get:()=>360}});
        HTMLMediaElement.prototype.load=function(){};
        HTMLMediaElement.prototype.pause=function(){};
        HTMLMediaElement.prototype.play=async function(){};
        // Chromium cannot decode the live HLS boundary in this fixture. Suppress
        // its synthetic network/codec failures; real iPhone HLS is tested separately.
        const listen=HTMLMediaElement.prototype.addEventListener;
        HTMLMediaElement.prototype.addEventListener=function(type,...args){
            if(type!=='error')listen.call(this,type,...args);
        };
    });
    const page=await context.newPage();
    await page.goto('https://www.tango.me/');
    await page.addScriptTag({content:bundle});
    await page.waitForFunction(()=>document.querySelectorAll('.stream-row').length===3);
    assert.deepEqual(await page.locator('.stream-row').evaluateAll(rows=>rows.map(r=>r.classList.contains('following'))),[true,false,false]);
    const before=requests.length;
    await page.addScriptTag({content:bundle});
    assert.equal(requests.length,before,'Reinjection must not restart authentication or provider requests');
    assert.equal(await page.locator('meta[name=viewport]').count(),1);
    const refreshes=requests.filter(path=>path.endsWith('/tokenData')).length;
    await page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
    await page.waitForFunction(()=>document.querySelectorAll('.stream-row').length===3);
    await page.waitForTimeout(100);
    assert.equal(requests.filter(path=>path.endsWith('/tokenData')).length,refreshes+1,'Restoring a document must refresh stream authentication once');
    await page.locator('.stream-row').first().click();
    await page.waitForURL('**/stream/stream-1');
    await page.addScriptTag({content:bundle});
    await page.waitForFunction(()=>document.querySelector('.stream-stage:not(.viewer-loading)')&&document.querySelector('button.download:not(:disabled)'));
    assert.equal(await page.locator('.stream-slot').count(),3);
    assert.equal(await page.locator('.current-scope video').getAttribute('src'),'https://media.invalid/1.m3u8');
    assert.equal(await page.locator('.next-scope video').getAttribute('src'),'https://media.invalid/2.m3u8');
    assert.equal(await page.locator('.previous-scope video').getAttribute('src'),null);
    await page.locator('button.mute').click();
    assert.equal(await page.locator('.current-scope video').evaluate(v=>v.muted),false);
    const writes=requests.length;
    await page.locator('button.block').click();
    assert.equal(requests.length,writes,'First block tap must only request confirmation');
    assert.equal(await page.locator('button.block').getAttribute('data-confirm'),'true');
    const saved=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('stream-viewer-state')));
    assert.equal(saved.streams.length,3);
    assert.equal(saved.currentStreamerId,'person-1');
    await testScrollSettlement(page);
    await page.goto('https://example.com/');
    const outside=requests.length;
    await page.addScriptTag({content:bundle});
    assert.equal(await page.locator('#original').textContent(),'Original');
    assert.equal(await page.evaluate(()=>window.__streamViewerExtensionBoot),undefined);
    assert.equal(requests.length,outside,'Unmatched sites must have no app requests');
    console.log('PASS: followed/recommended home, duplicate-entry guard, native stream URL, session handoff, three slots, mute, non-destructive block confirmation, and unmatched-site isolation.');
} finally {await browser.close();}
