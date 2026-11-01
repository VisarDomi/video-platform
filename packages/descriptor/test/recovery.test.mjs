import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,chmod,rm} from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {LlamaServer} from '../dist/llama-server.js';
import {descriptorConfig} from '../dist/config.js';
import {postJson} from '../dist/model-client.js';

async function fixture(t,scenario){
 const root=await mkdtemp(path.join(os.tmpdir(),'descriptor-recovery-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const listener=http.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));
 const port=listener.address().port;await new Promise(r=>listener.close(r));
 const executable=path.join(root,'fake-llama');
 await writeFile(executable,`#!${process.execPath}
const fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const root=__dirname,scenario=process.argv[process.argv.indexOf('-m')+1];
const starts=Number(fs.existsSync(root+'/starts')?fs.readFileSync(root+'/starts','utf8'):0)+1;
fs.writeFileSync(root+'/starts',String(starts));
const server=http.createServer((req,res)=>{
 if(req.url==='/health'){res.end('{}');return;}
 let body='';req.on('data',x=>body+=x);req.on('end',()=>{
  fs.appendFileSync(root+'/requests',body+'\\n');
  if(scenario==='always-crash'||scenario==='crash-once'&&starts===1){
   console.error('GGML_ASSERT fixture model failure');console.error('backtrace fixture\\n'.repeat(800));
   process.exit(86);
  }
  if(scenario==='shutdown'){process.kill(process.pid,'SIGTERM');return;}
  if(scenario==='body-abort'){res.writeHead(200);res.write('{"choices":');setTimeout(()=>res.destroy(),10);return;}
  if(scenario==='http-error'){res.writeHead(500);res.end('{"error":{"message":"fixture invalid request"}}');return;}
  res.end('{"choices":[{"message":{"content":"fixture response"}}]}');
 });
});
server.listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');
process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
`);
 await chmod(executable,0o700);
 const config={...descriptorConfig,runtimeExecutable:executable,modelPath:scenario,port,
  modelUrl:`http://127.0.0.1:${port}`,useExternalServer:false,startupTimeoutMilliseconds:3000,healthRequestTimeoutMilliseconds:100};
 const server=new LlamaServer(config);t.after(()=>server.stop());await server.start();
 const payload={messages:[{content:[{type:'input_video',input_video:{url:'file://fixture.mp4',fps:1}},{type:'text',text:'fixture prompt'}]}]};
 const request=async()=>{const r=await postJson(new URL('/v1/chat/completions',config.modelUrl),payload);if(r.status!==200)throw Error('Model request failed ('+r.status+')');return r;};
 return {server,root,request,payload,config,starts:async()=>Number(await readFile(root+'/starts','utf8')),
  requests:async()=>(await readFile(root+'/requests','utf8')).trim().split('\n').map(JSON.parse)};
}

test('a crashed owned model is restarted once and receives the identical request',async t=>{
 const f=await fixture(t,'crash-once');
 const result=await f.server.requestWithRecovery(f.request);
 assert.equal(result.status,200);assert.equal(await f.starts(),2);
 assert.deepEqual(await f.requests(),[f.payload,f.payload]);
});
test('a persistent crash stops after two attempts and preserves the assertion before the backtrace',async t=>{
 const f=await fixture(t,'always-crash');
 await assert.rejects(()=>f.server.requestWithRecovery(f.request),/GGML_ASSERT fixture model failure/);
 assert.equal(await f.starts(),2);assert.equal((await f.requests()).length,2);
});
test('ordinary model request errors do not restart a healthy owned server',async t=>{
 const f=await fixture(t,'http-error');
 await assert.rejects(()=>f.server.requestWithRecovery(f.request),/Model request failed \(500\)/);
 assert.equal(await f.starts(),1);assert.equal((await f.requests()).length,1);
});
test('SIGTERM shutdown does not trigger model recovery',async t=>{
 const f=await fixture(t,'shutdown');
 await assert.rejects(()=>f.server.requestWithRecovery(f.request));assert.equal(await f.starts(),1);
});
test('a mid-response disconnect rejects promptly without retrying a live server',async t=>{
 const f=await fixture(t,'body-abort');
 let timer;
 try{await assert.rejects(()=>Promise.race([f.server.requestWithRecovery(f.request),
  new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('hung response')),1500);})]),e=>!e.message.includes('hung response'));}
 finally{clearTimeout(timer);}
 assert.equal(await f.starts(),1);
});
test('an explicit stop cancels startup without leaving or recreating a child',async t=>{
 const f=await fixture(t,'http-error');await f.server.stop();
 const starting=f.server.start();await f.server.stop();
 await assert.rejects(()=>starting,/startup was stopped/);
 assert.equal(await f.starts(),1);
 await assert.rejects(()=>fetch(f.config.modelUrl+'/health'));
});
test('an externally managed endpoint is never restarted or retried',async t=>{
 const f=await fixture(t,'http-error');
 const external=new LlamaServer({...f.config,useExternalServer:true});await external.start();
 await assert.rejects(()=>external.requestWithRecovery(f.request));
 await external.stop();assert.equal(await f.starts(),1);assert.equal((await f.requests()).length,1);
 assert.equal((await fetch(f.config.modelUrl+'/health')).status,200);
});
