import assert from 'node:assert/strict';
import fs from 'node:fs';
import { webkit } from 'playwright-core';

const content = fs.readFileSync('dist/extension/bunkr/content.js', 'utf8');
const browser = await webkit.launch({headless:true, executablePath:process.env.WEBKIT_EXECUTABLE_PATH});
try {
    const drawing = await browser.newPage();
    const dimensions = [[1600,900],[100,400],[40,20],[1200,300]];
    const pictures = await drawing.evaluate(sizes => sizes.map(([width,height]) => {
        const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;return canvas.toDataURL('image/png');
    }), dimensions);
    await drawing.close();
    for (const domain of ['si','ph','cr']) {
        const context=await browser.newContext({viewport:{width:428,height:926},hasTouch:true});
        const page=await context.newPage();page.setDefaultTimeout(5000);
        const names=['A complete filename '+('long-name_'.repeat(12))+'.webm','Portrait original.mkv','Small original.mp4','Wide original.webm'];
        const jobs=new Map([
            ['a',{id:'a'.repeat(24),state:'downloading',bytes:62,total:100}],
            ['c',{id:'c'.repeat(24),state:'complete',bytes:100,total:100}],
            ['d',{id:'d'.repeat(24),state:'failed',bytes:12,total:100}],
        ]);
        let available=true,loseAck=true;const submissions=[],errors=[];
        page.on('pageerror',error=>errors.push(error.message));
        const cards=names.map((name,index)=>{
            const id='abcd'[index];return `<div class="theItem" title="${name}"><img class="grid-images_box-img" src="/small/${id}.png"><p class="theName truncate">${name}</p><p class="theSize">${index+1}.25 GB</p><span class="theDate">09:11:45 17/08/2024</span><a href="/f/${id}" target="_blank"></a></div>`;
        }).join('');
        const album=`<!doctype html><style>body{margin:100px}.theItem{padding:20px}.truncate{white-space:nowrap;overflow:hidden}</style><h1>Full album title ${'without truncation '.repeat(5)}</h1><p class="visitors"><span class="font-semibold">(12 GB) 4 Files</span> - 999 views</p><div id="galleryGrid">${cards}</div><aside id="ad">Unwanted</aside><script>window.siteExecuted=true</script>`;
        await context.route('**/*',async route=>{
            const url=new URL(route.request().url());
            if(url.pathname.startsWith('/a/'))return route.fulfill({contentType:'text/html',body:album});
            if(url.pathname.startsWith('/f/')){
                const id=url.pathname.split('/').at(-1);
                return route.fulfill({contentType:'text/html',body:`<h1>File ${id}</h1><meta property="og:image" content="/small/${id}.png"><script>var videoCoverUrl=${JSON.stringify(`https://bunkr.${domain}/posters/${id}_grid.png`)};window.fileExecuted=true;</script><a id="native-download" href="https://dl.bunkr.${domain}/file/42">Download</a>`});
            }
            if(url.pathname.startsWith('/posters/')){
                const index='abcd'.indexOf(url.pathname.split('/').at(-1)[0]);
                return route.fulfill({contentType:'image/png',body:Buffer.from(pictures[index].split(',')[1],'base64')});
            }
            if(url.pathname.startsWith('/small/'))return route.fulfill({contentType:'image/png',body:Buffer.from(pictures[2].split(',')[1],'base64')});
            return route.fulfill({status:404,body:''});
        });
        await page.exposeFunction('pcMessage',async message=>{
            if(!available)return {ok:false,status:0};
            const id=message.action==='status'?[...jobs].find(([,job])=>job.id===message.id)?.[0]:new URL(message.url).pathname.split('/').at(-1);
            if(message.action==='download'){
                submissions.push(message.url);jobs.set(id,{id:id.repeat(24),state:'downloading',bytes:35,total:100});
                if(loseAck){loseAck=false;return {ok:false,status:0};}
            }
            const job=jobs.get(id);return job?{ok:true,status:200,job:{...job}}:{ok:false,status:404};
        });
        await page.addInitScript(({content,domain})=>{
            window.browser={runtime:{sendMessage:message=>window.pcMessage(message)}};
            if(location.pathname.startsWith('/a/')){
                // A stale cached size must be corrected by the image's actual dimensions.
                const url=`https://bunkr.${domain}/f/a`;
                if(!sessionStorage.getItem('poster-fixture-seeded')){sessionStorage.setItem('bunkr-posters:v2',JSON.stringify({[url]:{url:`https://bunkr.${domain}/posters/a_grid.png`,width:200,height:112}}));sessionStorage.setItem('poster-fixture-seeded','1');}
                (0,eval)(content);
            } else document.addEventListener('DOMContentLoaded',()=>{(0,eval)(content);},{once:true});
        },{content,domain});
        const open=async()=>{
            await page.goto(`https://bunkr.${domain}/a/album`,{waitUntil:'commit'});
            await page.waitForFunction(()=>document.querySelectorAll('.album-row').length===4);
        };
        const button=id=>page.locator('.album-row').nth('abcd'.indexOf(id)).locator('button');
        const label=async(id,text)=>page.waitForFunction(({id,text})=>[...document.querySelectorAll('.album-row')].find(r=>r.dataset.fileURL?.endsWith('/'+id))?.querySelector('button')?.textContent.includes(text),{id,text});
        await open();await label('a','62%');
        assert.equal(submissions.length,0,'browsing never queues files');
        assert.equal(await page.locator('#ad').count(),0);
        assert.equal(await page.evaluate(()=>window.siteExecuted||window.fileExecuted||false),false,'source scripts must remain inert');
        await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));
        await page.waitForFunction(()=>[...document.querySelectorAll('.album-row img')].every(i=>i.naturalWidth>0&&i.src.includes('_grid.png')));
        await page.waitForFunction(()=>document.querySelector('.album-row img').getAttribute('width')==='1600');
        for(const viewport of [{width:428,height:926},{width:926,height:428},{width:320,height:568}]){
            await page.setViewportSize(viewport);
            await page.waitForFunction(()=>getComputedStyle(document.querySelectorAll('.album-name')[1]).fontSize==='15px'&&[...document.querySelectorAll('.album-row')].every(r=>r.querySelector('.album-details').getBoundingClientRect().height<=r.querySelector('img').getBoundingClientRect().height+.25));
            const layout=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,rows:[...document.querySelectorAll('.album-row')].map(r=>{
                const i=r.querySelector('img'),n=r.querySelector('.album-name'),d=r.querySelector('.album-details'),b=r.getBoundingClientRect(),p=i.getBoundingClientRect(),s=getComputedStyle(r);
                return {top:b.top,bottom:b.bottom,margin:s.margin,padding:s.padding,gap:s.gap,title:n.textContent,titleHeight:n.clientHeight,titleScroll:n.scrollHeight,image:[p.width,p.height],natural:[i.naturalWidth,i.naturalHeight],detailsHeight:d.getBoundingClientRect().height,font:parseFloat(getComputedStyle(n).fontSize)};
            })}));
            assert.ok(layout.scrollWidth<=layout.width,layout);
            layout.rows.forEach((r,index)=>{
                assert.equal(r.title,names[index]);assert.ok(r.titleScroll<=r.titleHeight+1,r);
                assert.equal(r.margin,'0px');assert.equal(r.padding,'0px');assert.equal(r.gap,'0px');
                if(index)assert.ok(Math.abs(r.top-layout.rows[index-1].bottom)<.5,'no gaps between rows');
                assert.ok(r.image[0]<=r.natural[0]+.5&&r.image[1]<=r.natural[1]+.5,r);
                assert.ok(Math.abs(r.image[0]/r.image[1]-r.natural[0]/r.natural[1])<.02,r);
                assert.ok(r.detailsHeight<=r.image[1]+.25,'details must fit the actual thumbnail height');
                assert.ok(r.font>0&&r.font<=15,'text only shrinks');
                assert.ok(Math.abs((r.bottom-r.top)-r.image[1]-1)<.5,'only the thumbnail and separator determine row height');
            });
            assert.equal(layout.rows[1].font,15,'short text with room keeps the original size');
        }
        await page.setViewportSize({width:428,height:926});
        await button('a').evaluate(element=>{element.closest('.album-row').querySelector('.album-name').textContent='A complete filename '.repeat(80)+'.webm';});
        await page.setViewportSize({width:320,height:568});
        await page.waitForFunction(()=>{const r=document.querySelector('.album-row');return parseFloat(getComputedStyle(r.querySelector('.album-name')).fontSize)<15&&r.querySelector('.album-details').getBoundingClientRect().height<=r.querySelector('img').getBoundingClientRect().height+.25;});
        // The same row must grow its text back after a shorter title, not stay at its last fit.
        await button('a').evaluate(element=>{element.closest('.album-row').querySelector('.album-name').textContent='Short.webm';});
        await page.setViewportSize({width:430,height:926});
        await page.waitForFunction(()=>getComputedStyle(document.querySelector('.album-name')).fontSize==='15px');
        await page.setViewportSize({width:428,height:926});
        await button('b').scrollIntoViewIfNeeded();await page.waitForTimeout(80);
        await button('b').evaluate(element=>{element.click();element.click();});await label('b','35%');
        assert.equal(submissions.length,1,'double taps and lost acknowledgements submit once');
        available=false;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await label('b','reconnecting');
        await page.waitForFunction(()=>{const r=document.querySelectorAll('.album-row')[1];return r.querySelector('.album-details').getBoundingClientRect().height<=r.querySelector('img').getBoundingClientRect().height+.25;});
        await button('b').click();assert.equal(submissions.length,1);
        await open();await label('b','35%');await label('b','reconnecting');assert.equal(submissions.length,1,'refresh rejoins the cached existing job');
        available=true;jobs.get('b').bytes=81;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await label('b','81%');
        await button('d').scrollIntoViewIfNeeded();await label('d','failed');await button('d').click();await label('d','35%');assert.equal(submissions.length,2);
        assert.deepEqual(errors,[]);
        console.log('PASS album:',domain,'takeover, full text, intrinsic posters, dynamic text fitting/rotation/restoration, tight rows, status, offline/retry/deduplication');
        await context.close();
    }
} finally { await browser.close(); }
