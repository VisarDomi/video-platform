import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LlamaServer } from '../dist/llama-server.js';
import { descriptorConfig } from '../dist/config.js';

async function fixture(t, scenario, timeout = 2000) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'descriptor-lifecycle-'));
    t.after(()=>rm(root,{recursive:true,force:true}));
    const server = http.createServer();
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port = server.address().port;
    await new Promise(resolve=>server.close(resolve));
    const executable = path.join(root,'fake-llama');
    await writeFile(executable, `#!${process.execPath}
const http = require('node:http');
const scenario = process.argv[process.argv.indexOf('-m')+1];
if(scenario==='exit') { console.error('fixture model load failure'); process.exit(7); }
if(scenario==='signal') { process.kill(process.pid,'SIGTERM'); }
const port = Number(process.argv[process.argv.indexOf('--port')+1]);
const start = Date.now();
const server = http.createServer((req,res)=> {
  if(scenario==='hang') return;
  const ready = scenario==='slow' ? Date.now()-start>=700 : scenario==='ready';
  res.writeHead(ready ? 200 : 503); res.end('{}');
});
server.listen(port,'127.0.0.1');
process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
`);
    await chmod(executable,0o700);
    const config = { ...descriptorConfig, runtimeExecutable: executable, modelPath: scenario, port,
        modelUrl: `http://127.0.0.1:${port}`, startupTimeoutMilliseconds: timeout,
        healthRequestTimeoutMilliseconds: 50, useExternalServer: false };
    const llama = new LlamaServer(config);
    t.after(()=>llama.stop());
    return { llama, config };
}

test('slow loading gets a bounded startup window, then clean stop and restart', async t=>{
    const {llama,config}=await fixture(t,'slow');
    for(let i=0;i<2;i++) {
        await llama.start();
        assert.equal((await fetch(`${config.modelUrl}/health`)).status,200);
        await llama.stop();
        await assert.rejects(()=>fetch(`${config.modelUrl}/health`));
    }
});
for(const scenario of ['never','hang']) {
    test(`startup timeout cleans the child even when health ${scenario==='hang'?'hangs':'stays loading'}`,async t=>{
        const {llama,config}=await fixture(t,scenario,400);
        const start=Date.now();
        await assert.rejects(()=>llama.start(),/did not become healthy/);
        assert(Date.now()-start<2500);
        await assert.rejects(()=>fetch(`${config.modelUrl}/health`));
    });
}
test('child failure exposes model logs instead of waiting for a generic timeout',async t=>{
    const {llama}=await fixture(t,'exit');
    await assert.rejects(()=>llama.start(),/exited \(7\).*fixture model load failure/s);
});
test('signal death and missing executable fail promptly',async t=>{
    const {llama,config}=await fixture(t,'signal');
    await assert.rejects(()=>llama.start(),/SIGTERM/);
    const missing=new LlamaServer({...config,runtimeExecutable:'/nonexistent/descriptor-runtime'});
    await assert.rejects(()=>missing.start(),/Failed to launch llama-server/);
    await missing.stop();
});

test('managed startup never adopts or stops an unrelated healthy endpoint',async t=>{
    const {llama,config}=await fixture(t,'ready');
    const other=http.createServer((req,res)=>res.end('{}'));
    await new Promise(resolve=>other.listen(config.port,'127.0.0.1',resolve));
    t.after(()=>new Promise(resolve=>{other.closeAllConnections();other.close(resolve);}));
    await assert.rejects(()=>llama.start(),/already occupied/);
    await llama.stop();
    assert.equal((await fetch(`${config.modelUrl}/health`)).status,200);
});
