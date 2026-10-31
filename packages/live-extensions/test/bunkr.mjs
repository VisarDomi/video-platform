import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webkit } from 'playwright-core';

const content=fs.readFileSync('dist/extension/bunkr/content.js','utf8');
const manifest=JSON.parse(fs.readFileSync('dist/extension/bunkr/manifest.json','utf8'));
for(const domain of ['si','ph','cr'])assert.ok(manifest.content_scripts[0].matches.includes(`https://bunkr.${domain}/*`));
assert.ok(manifest.host_permissions.includes('https://192.168.1.197:9998/*'));
let listener;const calls=[];
vm.runInNewContext(fs.readFileSync('dist/extension/bunkr/background.js','utf8'),{
    URL,AbortController,setTimeout,clearTimeout,
    browser:{runtime:{onMessage:{addListener:fn=>{listener=fn;}}}},
    fetch:async(url,init)=>{calls.push({url,init});return Response.json(url.endsWith('/health')?{service:'video-platform-bunkr'}:{id:'a'.repeat(24)});},
});
assert.equal(listener({action:'download',url:'https://bunkr.cr/f/abc'},{url:'https://evil.test'}),undefined);
assert.equal(listener({action:'download',url:'http://bunkr.cr/f/abc'},{url:'https://bunkr.cr/f/abc'}),undefined);
assert.equal((await listener({action:'health'},{url:'https://bunkr.cr/f/abc'})).ok,true);
assert.equal((await listener({action:'download',url:'https://bunkr.si/f/abc'},{url:'https://bunkr.si/f/abc'})).ok,true);
assert.equal(calls.at(-1).init.headers['X-Video-Download'],'1');

const browser=await webkit.launch({headless:true,executablePath:process.env.WEBKIT_EXECUTABLE_PATH});
try{
    for(const domain of ['si','ph','cr']){
        const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true});
        const errors=[];
        await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<a id="download" href="https://dl.bunkr.${domain}/file/42" target="_blank"><span>Download</span></a><a id="related" href="/f/other">Related</a>`}));
        const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
        await page.addInitScript(()=>{
            window.available=true;window.failSubmit=false;window.requests=[];window.nativeClicks=0;
            document.addEventListener('click',e=>{window.nativeClicks++;e.preventDefault();});
            window.browser={runtime:{sendMessage:async m=>{
                window.requests.push(m);
                if(m.action==='health')return {ok:window.available};
                if(m.action==='download')return window.failSubmit?{ok:false}:{ok:true,job:{id:'a'.repeat(24)}};
                return {ok:true,job:{state:'complete',bytes:11,total:11}};
            }}};
        });
        await page.goto(`https://bunkr.${domain}/f/abc`);await page.addScriptTag({content});
        await page.waitForFunction(()=>window.requests.some(m=>m.action==='health'));
        await page.locator('#download span').click();await page.waitForFunction(()=>document.querySelector('#download').textContent.includes('Downloaded'));
        await page.locator('#download').click();assert.equal(await page.evaluate(()=>window.requests.filter(m=>m.action==='download').length),1);
        assert.equal(await page.evaluate(()=>window.nativeClicks),0);
        await page.locator('#related').click();assert.equal(await page.evaluate(()=>window.nativeClicks),1);
        await page.reload();await page.evaluate(()=>{window.available=false;});await page.addScriptTag({content});
        await page.waitForTimeout(50);await page.locator('#download').click();assert.equal(await page.evaluate(()=>window.nativeClicks),1);
        assert.equal(await page.evaluate(()=>window.requests.filter(m=>m.action==='download').length),0,'unreachable PC leaves native download alone');
        await page.reload();await page.evaluate(()=>{window.failSubmit=true;});await page.addScriptTag({content});await page.waitForTimeout(50);
        await page.locator('#download').click();await page.waitForFunction(()=>document.querySelector('#download').textContent.includes('tap to retry'));
        await page.evaluate(()=>{window.failSubmit=false;});await page.locator('#download').click();
        await page.waitForFunction(()=>document.querySelector('#download').textContent.includes('Downloaded'));
        assert.equal(await page.evaluate(()=>window.requests.filter(m=>m.action==='download').length),2,'lost acknowledgement retries the same page');
        assert.deepEqual(errors,[]);await context.close();
    }
    console.log('PASS: Bunkr background scope and iPhone WebKit click handoff, offline fallback, deduplication and retry on all three domains.');
}finally{await browser.close();}
