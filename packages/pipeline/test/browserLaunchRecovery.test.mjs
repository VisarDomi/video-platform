import assert from 'node:assert/strict';
import test from 'node:test';
import { ChromiumPorntrexUploader } from '../dist/upload/chromiumPorntrexUploader.js';
import { HumanActionRequiredError } from '../dist/upload/browserUpload.js';
const config={executablePath:'/test/chromium',profilePath:'/test/profile'};
function context(){
 let closed=false;
 const field={count:async()=>1,waitFor:async()=>{}};
 const page={goto:async()=>({ok:()=>true}),locator:selector=>selector==='#overlay'?{isVisible:async()=>false}:field};
 return {clearCookies:async()=>{},pages:()=>[page],close:async()=>{closed=true;},get closed(){return closed;}};
}
test('a transient browser launch failure retries once without prompting login',async()=>{
 const ctx=context();let launches=0,waits=0;
 const uploader=new ChromiumPorntrexUploader(config,async()=>{if(++launches===1)throw Error('profile is still closing');return ctx;},async()=>{waits++;});
 assert.equal(await uploader.withAuthenticatedPage(async()=> 'healthy'),'healthy');
 assert.equal(launches,2);assert.equal(waits,1);assert(ctx.closed);
});
test('exhausted browser launches preserve the cause and remain ordinary retryable failures',async()=>{
 const cause=Error('Failed to create a ProcessSingleton for the profile');let launches=0;
 const uploader=new ChromiumPorntrexUploader(config,async()=>{launches++;throw cause;},async()=>{});
 await assert.rejects(uploader.withAuthenticatedPage(async()=>{}),error=>{
  assert(!(error instanceof HumanActionRequiredError));assert.equal(error.cause,cause);assert.match(error.message,/ProcessSingleton/);return true;
 });
 assert.equal(launches,2);
});
