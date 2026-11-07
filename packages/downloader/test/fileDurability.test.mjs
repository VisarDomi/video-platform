import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {FileSystemManager} from '../dist/common/fileSystemManager.js';

function storage(t,failSync=false){
    const events=[];
    t.mock.method(fs,'writeFile',async()=>{events.push('unflushed-write');});
    t.mock.method(fs,'appendFile',async()=>{events.push('unflushed-append');});
    t.mock.method(fs,'mkdir',async()=>undefined);
    t.mock.method(fs,'open',async(path)=>({
        writeFile:async()=>events.push('write:'+path),
        sync:async()=>{events.push('sync:'+path);if(failSync&&String(path).endsWith('.ts'))throw Object.assign(Error('disk flush failed'),{code:'EIO'});},
        close:async()=>events.push('close:'+path),
    }));
    return events;
}

test('exclusive media success requires payload and parent-directory durability first',async t=>{
    const events=storage(t);assert.equal(await FileSystemManager.writeFileExclusive('/capture/segment.ts',Buffer.from('media')),'written');events.push('success');
    assert.ok(events.indexOf('sync:/capture/segment.ts')>=0,'payload was never flushed');
    assert.ok(events.indexOf('sync:/capture')>events.indexOf('sync:/capture/segment.ts'),'file name must be durable after its payload');
    assert.ok(events.indexOf('success')>events.indexOf('sync:/capture'));
});

test('flush failure cannot authorize a playlist reference and always closes the payload handle',async t=>{
    const events=storage(t,true);assert.equal(await FileSystemManager.writeFileExclusive('/capture/segment.ts',Buffer.from('media')),'failed');
    assert.ok(events.includes('close:/capture/segment.ts'));
    assert.ok(!events.includes('sync:/capture'),'failed payload must not be committed as a durable file name');
});

test('playlist append success requires its contents and name to be flushed',async t=>{
    const events=storage(t);assert.equal(await FileSystemManager.appendFile('/capture/playlist.m3u8','#EXTINF:1,\nsegment.ts\n'),true);
    assert.ok(events.includes('sync:/capture/playlist.m3u8'));assert.ok(events.includes('sync:/capture'));
});

test('recording materialization flushes the complete directory path before returning',async t=>{
    const events=storage(t);assert.equal(await FileSystemManager.ensureDirExists('/capture/new/recording'),true);
    for(const path of ['/capture/new/recording','/capture/new','/capture','/'])assert.ok(events.includes('sync:'+path),'unflushed path component '+path);
});
