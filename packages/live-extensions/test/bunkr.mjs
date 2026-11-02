import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto,createHash } from 'node:crypto';
import { webkit } from 'playwright-core';

const content=fs.readFileSync('dist/extension/bunkr/content.js','utf8');
const manifest=JSON.parse(fs.readFileSync('dist/extension/bunkr/manifest.json','utf8'));
for(const domain of ['si','ph','cr']){
    assert.ok(manifest.content_scripts.some(script=>script.run_at==='document_start'&&script.matches.includes(`https://bunkr.${domain}/a/*`)));
    assert.ok(manifest.content_scripts.some(script=>script.run_at==='document_end'&&script.matches.includes(`https://bunkr.${domain}/f/*`)));
}
assert.ok(manifest.host_permissions.includes('https://192.168.1.197:9998/*'));
let listener;const calls=[];
vm.runInNewContext(fs.readFileSync('dist/extension/bunkr/background.js','utf8'),{
    URL,AbortController,setTimeout,clearTimeout,crypto:webcrypto,TextEncoder,
    browser:{runtime:{onMessage:{addListener:fn=>{listener=fn;}}}},
    fetch:async(url,init)=>{calls.push({url,init});return Response.json(url.endsWith('/health')?{service:'video-platform-bunkr'}:{id:'a'.repeat(24)});},
});
assert.equal(listener({action:'download',url:'https://bunkr.cr/f/abc'},{url:'https://evil.test'}),undefined);
assert.equal(listener({action:'download',url:'http://bunkr.cr/f/abc'},{url:'https://bunkr.cr/f/abc'}),undefined);
assert.equal((await listener({action:'health'},{url:'https://bunkr.cr/f/abc'})).ok,true);
assert.equal((await listener({action:'download',url:'https://bunkr.si/f/abc'},{url:'https://bunkr.si/f/abc'})).ok,true);
assert.equal(calls.at(-1).init.headers['X-Video-Download'],'1');
await listener({action:'lookup',url:'https://bunkr.cr/f/abc/?tracking=yes'},{url:'https://bunkr.cr/f/abc/'});
assert.equal(calls.at(-1).url,`https://192.168.1.197:9998/api/bunkr/downloads/${createHash('sha256').update('/f/abc').digest('hex').slice(0,24)}`,'lookup reuses the PC canonical page ID without enqueueing');
assert.equal(calls.at(-1).init.method,undefined);

const browser=await webkit.launch({headless:true,executablePath:process.env.WEBKIT_EXECUTABLE_PATH});
try{
    for(const domain of ['si','ph','cr']){
        const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true});
        let available=true,job=null,loseAck=false,hangNext=false;const requests=[],errors=[];
        await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<a id="download" href="https://dl.bunkr.${domain}/file/42" target="_blank"><span>Download</span></a><a id="related" href="/f/other">Related</a>`}));
        const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(3000);
        await page.exposeFunction('pcMessage',async message=>{
            requests.push(message);
            if(hangNext){hangNext=false;return new Promise(()=>{});}
            if(!available)return {ok:false,status:0};
            if(message.action==='health')return {ok:true,status:200};
            if(message.action==='download'){
                job={id:'a'.repeat(24),state:'downloading',bytes:35,total:100};
                if(loseAck){loseAck=false;return {ok:false,status:0};}
            }
            return job?{ok:true,status:200,job:{...job}}:{ok:false,status:404};
        });
        await page.addInitScript(()=>{
            // Advance only the bridge-deadline clock for a deterministic suspension check.
            const schedule=window.setTimeout.bind(window);
            window.setTimeout=(callback,delay,...args)=>schedule(callback,delay===7000?100:delay,...args);
            window.nativeClicks=0;document.addEventListener('click',e=>{window.nativeClicks++;e.preventDefault();});
            window.browser={runtime:{sendMessage:message=>window.pcMessage(message)}};
        });
        const load=async()=>{await page.goto(`https://bunkr.${domain}/f/abc`);await page.addScriptTag({content});};
        const label=async text=>page.waitForFunction(text=>document.querySelector('#download').textContent.includes(text),text);
        const submissions=()=>requests.filter(m=>m.action==='download').length;
        await load();await page.waitForTimeout(60);await page.locator('#download span').click();await label('35%');
        assert.equal(submissions(),1);assert.equal(await page.evaluate(()=>window.nativeClicks),0);
        job.bytes=62;await load();await label('62%');assert.equal(submissions(),1,'refresh discovers the PC job without a second tap or POST');
        available=false;await load();await label('62%');await label('reconnecting');
        await page.locator('#download').click();assert.equal(submissions(),1);assert.equal(await page.evaluate(()=>window.nativeClicks),0,'known PC jobs never become accidental phone downloads during an outage');
        available=true;job.bytes=81;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await label('81%');
        assert.equal(submissions(),1,'reconnect rejoins the existing transfer');
        job.bytes=90;hangNext=true;
        await page.evaluate(()=>{window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('online'));});
        await label('90%');assert.equal(submissions(),1,'a suspended extension reply cannot wedge future status checks');
        job.bytes=92;job.state='queued';await load();await label('92%');await label('Resuming');
        job.state='complete';await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await label('Downloaded');
        await page.locator('#download').click();assert.equal(submissions(),1);
        await page.locator('#related').click();assert.equal(await page.evaluate(()=>window.nativeClicks),1);
        await page.evaluate(()=>sessionStorage.clear());job=null;available=false;await load();await page.waitForTimeout(60);
        await page.locator('#download').click();assert.equal(await page.evaluate(()=>window.nativeClicks),1,'a new download keeps native behavior when no PC job is known');
        available=true;loseAck=true;await load();await page.waitForTimeout(60);await page.locator('#download').click();await label('35%');
        assert.equal(submissions(),2,'a lost acknowledgement is recovered by lookup, never by automatically submitting twice');
        assert.deepEqual(errors,[]);await context.close();
    }
    console.log('PASS: Bunkr background scope and iPhone WebKit handoff, refresh restoration, cached offline progress, reconnect, lost acknowledgement and deduplication on all three domains.');
}finally{await browser.close();}
