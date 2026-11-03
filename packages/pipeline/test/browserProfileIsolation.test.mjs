import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createProviderUploader} from '../dist/upload/providerFactory.js';
import {ChromiumPorntrexUploader} from '../dist/upload/chromiumPorntrexUploader.js';
const configURL=new URL('../dist/config.js',import.meta.url).href;
test('the durable browser profile belongs to the pipeline database directory, including overridden databases',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'pipeline-profile-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const db=path.join(root,'own-data','pipeline.sqlite');
 const env={...process.env,VIDEO_PIPELINE_DB:db};delete env.VIDEO_PORNTREX_BROWSER_PROFILE;
 const out=JSON.parse(execFileSync(process.execPath,['--no-warnings','--input-type=module','-e',`import {pipelineConfig as c} from ${JSON.stringify(configURL)};console.log(JSON.stringify([c.browserProfilePath,c.porntrexBrowserProfilePath]));`],{env,encoding:'utf8'}));
 assert.deepEqual(out,[path.join(path.dirname(db),'browser'),path.join(path.dirname(db),'browser')]);
});
test('the shared agent profile and its aliases are refused before reading credentials or launching',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'pipeline-reserved-profile-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const shared=path.join(os.homedir(),'.config','chromium-agent'),alias=path.join(root,'alias');await symlink(shared,alias);
 for(const profile of [shared,path.join(shared,'Default'),alias,path.join(alias,'not-created-yet')]){
  await assert.rejects(createProviderUploader({browserProfilePath:profile,credentialsFilePath:path.join(root,'missing.json')},'porntrex'),/reserved.*agent|shared agent profile/i);
 }
});
test('service launches retain one encrypted cookie backend and exclude Playwright basic/mock keychains',async()=>{
 let options;const field={count:async()=>1,waitFor:async()=>{}};
 const page={goto:async()=>({ok:()=>true}),locator:s=>s==='#overlay'?{isVisible:async()=>false}:field};
 const ctx={clearCookies:async()=>{},pages:()=>[page],close:async()=>{}};
 const uploader=new ChromiumPorntrexUploader({profilePath:'/test/pipeline/browser',executablePath:'/test/chromium'},async(_p,o)=>{options=o;return ctx;},async()=>{});
 await uploader.withAuthenticatedPage(async()=>{});
 assert(options.args.includes('--password-store=gnome-libsecret'));
 assert(options.ignoreDefaultArgs.includes('--password-store=basic'));
 assert(options.ignoreDefaultArgs.includes('--use-mock-keychain'));
});
