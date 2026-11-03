import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import express from 'express';
import {getProviderPaths} from '../dist/core/config.js';
import hls from '../dist/api/hls.routes.js';

test('shared HLS responses preserve stored playlist and fragment bytes',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'hls-passthrough-'));
 const paths=getProviderPaths('sc'),previous={...paths};
 Object.assign(paths,{downloaded:path.join(root,'downloaded'),edited:path.join(root,'edited'),trash:path.join(root,'trash')});
 const folder=path.join(paths.downloaded,'fixture');await mkdir(folder,{recursive:true});
 const playlist='#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.123456,\n0.ts\n#EXT-X-ENDLIST\n';
 const segment=Buffer.alloc(188*3,0x47),initialization=Buffer.from('original initialization bytes');
 await Promise.all([writeFile(path.join(folder,'playlist.m3u8'),playlist),writeFile(path.join(folder,'0.ts'),segment),writeFile(path.join(folder,'init.mp4'),initialization)]);
 const app=express();app.use(hls);const server=app.listen(0,'127.0.0.1');
 await new Promise(resolve=>server.once('listening',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));Object.assign(paths,previous);await rm(root,{recursive:true,force:true});});
 const origin='http://127.0.0.1:'+server.address().port+'/hls/sc/fixture/';
 for(const [name,bytes,type] of [['playlist.m3u8',Buffer.from(playlist),'application/vnd.apple.mpegurl'],['0.ts',segment,'video/mp2t'],['init.mp4',initialization,'video/mp4']]){
  const response=await fetch(origin+name);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  if(name!=='playlist.m3u8')assert.ok(response.headers.get('content-type').startsWith(type));
 }
});
