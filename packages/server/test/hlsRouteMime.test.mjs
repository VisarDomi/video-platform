import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

test('the HLS route serves fMP4 .ts files as MP4 and keeps real transport streams unchanged',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'hls-mime-'));
 const previous=process.env.VIDEO_DOWNLOADS_ROOT;process.env.VIDEO_DOWNLOADS_ROOT=root;
 t.after(async()=>{if(previous===undefined)delete process.env.VIDEO_DOWNLOADS_ROOT;else process.env.VIDEO_DOWNLOADS_ROOT=previous;await rm(root,{recursive:true,force:true});});
 const {getProviderPaths}=await import('../dist/core/config.js');const paths=getProviderPaths('sc');assert(paths.downloaded.startsWith(root+path.sep));
 const name='2026-01-01 010000 mime-fixture';const folder=path.join(paths.downloaded,name);await mkdir(folder,{recursive:true});
 const fragment=Buffer.alloc(24);fragment.writeUInt32BE(8);fragment.write('moof',4);fragment.writeUInt32BE(16,8);fragment.write('mdat',12);fragment.fill(0x12,16);
 const ts=Buffer.alloc(376,0x47);await writeFile(path.join(folder,'fragment.ts'),fragment);await writeFile(path.join(folder,'transport.ts'),ts);
 const {default:router}=await import('../dist/api/hls.routes.js');const app=express();app.use(router);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const base=`http://127.0.0.1:${server.address().port}/hls/sc/${encodeURIComponent(name)}`;
 const response=await fetch(base+'/fragment.ts');assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'video/mp4');assert.deepEqual(Buffer.from(await response.arrayBuffer()),fragment);
 const original=await fetch(base+'/transport.ts');assert.equal(original.headers.get('content-type'),'video/mp2t');assert.deepEqual(Buffer.from(await original.arrayBuffer()),ts);
});
