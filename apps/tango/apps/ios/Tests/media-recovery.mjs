import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {webkit} from '../../../../../manga/gallery-downloader/node_modules/playwright-core/index.mjs';
const output=await build({entryPoints:['apps/ios/web/media-recovery.ts'],bundle:true,write:false,format:'iife',globalName:'Recovery'});
const browser=await webkit.launch();
try {
 for(const live of [false,true]) {
  const page=await browser.newPage();
  await page.goto('about:blank');
  await page.addScriptTag({content:output.outputFiles[0].text});
  const result=await page.evaluate(live=>{
   let next=0; const timers=new Map();
   window.setTimeout=(fn,ms)=>{timers.set(++next,{fn,ms});return next};
   window.clearTimeout=id=>timers.delete(id);
   const tick=()=>{const jobs=[...timers.values()];timers.clear();for(const job of jobs)job.fn();};
   let online=true;Object.defineProperty(navigator,'onLine',{get:()=>online});
   Recovery.installMediaRecovery(live);
   const video=document.createElement('video'); video.setAttribute('src','https://fixture.invalid/video');video.muted=false;video.autoplay=true;
   let time=12,paused=false,error=null,loads=0,plays=0,rawErrors=0;
   Object.defineProperties(video,{currentTime:{get:()=>time,set:value=>time=value},paused:{get:()=>paused},error:{get:()=>error},readyState:{get:()=>0}});
   video.load=()=>{loads++;time=0;paused=true};video.play=async()=>{plays++;paused=false};
   document.body.append(video);video.addEventListener('error',()=>rawErrors++);
   video.dispatchEvent(new Event('play'));video.dispatchEvent(new Event('timeupdate'));
   error={code:2};video.dispatchEvent(new Event('error'));tick();
   error=null;video.dispatchEvent(new Event('loadedmetadata'));
   const recovered={loads,plays,time,muted:video.muted,rawErrors};
   video.dispatchEvent(new Event('playing'));
   paused=true;video.dispatchEvent(new Event('pause'));
   time=25;video.dispatchEvent(new Event('timeupdate'));error={code:2};video.dispatchEvent(new Event('error'));tick();
   error=null;video.dispatchEvent(new Event('loadedmetadata'));
   const keptPaused=paused && !video.autoplay && plays===1;
   error={code:4};video.dispatchEvent(new Event('error'));const permanent=rawErrors===1&&timers.size===0;
   error={code:2};online=false;video.dispatchEvent(new Event('error'));tick();const offlineLoads=loads;
   online=true;dispatchEvent(new Event('online'));const resumed=loads===offlineLoads+1;
   error=null;video.dispatchEvent(new Event('loadedmetadata'));
   error={code:2};video.dispatchEvent(new Event('error'));video.setAttribute('src','https://fixture.invalid/other');const before=loads;tick();
   return {recovered,keptPaused,permanent,resumed,obsoleteIgnored:loads===before};
  },live);
  assert.deepEqual(result.recovered,{loads:1,plays:1,time:live?0:12,muted:false,rawErrors:0});
  assert(result.keptPaused);assert(result.permanent);assert(result.resumed);assert(result.obsoleteIgnored);
  await page.close();
 }
 console.log('PASS: WebKit network-error recovery, VOD time/mute/pause, permanent format fallback, online recovery, and obsolete-source cancellation');
} finally {await browser.close();}
