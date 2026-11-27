import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DescriptorStartupError, LlamaServer, parseProcessMemory } from '../dist/llama-server.js';
import { descriptorConfig } from '../dist/config.js';

async function fixture(t, scenario, timeout = 2000, maxKeptMemoryBytes) {
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
const held = [];
const server = http.createServer((req,res)=> {
  if(scenario==='hang') return;
  if(req.url==='/grow') { held.push(Buffer.alloc(64*2**20, 1)); res.end('{}'); return; }
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
    const llama = new LlamaServer(config, undefined, maxKeptMemoryBytes);
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
        await assert.rejects(()=>llama.start(),error=>error instanceof DescriptorStartupError&&/did not become healthy/.test(error.message));
        assert(Date.now()-start<2500);
        await assert.rejects(()=>fetch(`${config.modelUrl}/health`));
    });
}
test('child failure exposes model logs instead of waiting for a generic timeout',async t=>{
    const {llama}=await fixture(t,'exit');
    await assert.rejects(()=>llama.start(),error=>error instanceof DescriptorStartupError&&/exited \(7\).*fixture model load failure/s.test(error.message));
});
test('signal death and missing executable fail promptly',async t=>{
    const {llama,config}=await fixture(t,'signal');
    await assert.rejects(()=>llama.start(),/SIGTERM/);
    const missing=new LlamaServer({...config,runtimeExecutable:'/nonexistent/descriptor-runtime'});
    await assert.rejects(()=>missing.start(),error=>error instanceof DescriptorStartupError&&/Failed to launch llama-server/.test(error.message));
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

test('slow startup progress logs elapsed seconds, last llama-server line and io pressure', async t => {
    const { config } = await fixture(t, 'slow');
    const root = path.dirname(config.runtimeExecutable);
    const verboseExe = path.join(root, 'fake-llama-verbose');
    await writeFile(verboseExe, `#!${process.execPath}
const http = require('node:http');
console.error('llama_model_loader: loading tensors from fixture.gguf');
const port = Number(process.argv[process.argv.indexOf('--port')+1]);
const start = Date.now();
const server = http.createServer((req,res)=> {
  res.writeHead(Date.now()-start>=700 ? 200 : 503); res.end('{}');
});
server.listen(port,'127.0.0.1');
process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
`);
    await chmod(verboseExe, 0o700);
    const llama = new LlamaServer({ ...config, runtimeExecutable: verboseExe }, 100);
    t.after(() => llama.stop());
    const logs = [];
    const orig = console.log;
    console.log = (line) => logs.push(String(line));
    try { await llama.start(); } finally { console.log = orig; }
    const progress = logs.map(l => { try { return JSON.parse(l); } catch { return null; } }).find(e => e?.event === 'descriptor-starting');
    assert(progress, 'expected descriptor-starting progress event');
    assert.equal(typeof progress.elapsedSeconds, 'number');
    assert.match(progress.lastLogLine, /loading tensors/);
    assert('ioPressureSomeAvg10' in progress);
});
test('a server kept loaded starts once, is reused, and starts again after it died', async t=>{
    const {llama,config}=await fixture(t,'ready');
    assert.equal(llama.running,false);
    await llama.ensureStarted();
    assert.equal(llama.running,true);
    const first=llama.child.pid;
    await llama.ensureStarted();
    assert.equal(llama.child.pid,first,'the running server is reused');
    llama.child.kill('SIGKILL');
    await new Promise(resolve=>llama.child.once('exit',resolve));
    assert.equal(llama.running,false);
    await llama.ensureStarted();
    assert.notEqual(llama.child.pid,first);
    assert.equal((await fetch(`${config.modelUrl}/health`)).status,200);
    await llama.stop();
    assert.equal(llama.running,false);
});

// The status of a freshly started description server: 9.95 GB resident, 3.7 GB of it the
// model files' page cache. Counted by VmRSS it was already at a 10 GiB ceiling, so it
// started again after nearly every description.
const startedServerStatus = `Name:\tllama-server
VmRSS:\t 9950716 kB
RssAnon:\t 6045600 kB
RssFile:\t 3818000 kB
RssShmem:\t   87116 kB
`;
test('the memory a kept server holds is its anonymous and shared memory, not the model files it maps', () => {
    const memory = parseProcessMemory(startedServerStatus);
    assert.deepEqual(memory, { heldBytes: (6045600 + 87116) * 1024, anonBytes: 6045600 * 1024,
        fileBytes: 3818000 * 1024, rssBytes: 9950716 * 1024 });
    assert.ok(memory.heldBytes < 10 * 2 ** 30 && memory.rssBytes > 9 * 2 ** 30);
    assert.equal(parseProcessMemory('Name:\tkernel-thread\n'), null);
});

test('a kept server that grows past the memory ceiling starts again before the next description', async t => {
    // A ceiling above what the fixture holds when started, below it after it grows.
    const {llama,config}=await fixture(t,'ready',2000,160*2**20);
    await llama.ensureStarted();
    const first=llama.child.pid;
    await llama.ensureStarted();
    assert.equal(llama.child.pid,first,'below the ceiling it is kept');
    for (let i=0;i<3;i++) await (await fetch(`${config.modelUrl}/grow`)).text();
    const lines=[];
    const log=console.log;
    console.log=(line)=>lines.push(line);
    try { await llama.ensureStarted(); } finally { console.log=log; }
    assert.notEqual(llama.child.pid,first);
    const recycle=JSON.parse(lines.find(line=>line.includes('descriptor-recycle')));
    assert.equal(recycle.reason,'memory_ceiling');
    assert.equal(recycle.descriptionsServed,2);
    assert.ok(recycle.heldBytes>recycle.limitBytes && recycle.fileBytes>0);
});
