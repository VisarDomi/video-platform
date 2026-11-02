import assert from 'node:assert/strict';
import test from 'node:test';
import {hlsSegmentContentType} from '../dist/services/hls/segmentContentType.js';

function box(type,payload=Buffer.alloc(0)){
 const data=Buffer.alloc(8+payload.length);data.writeUInt32BE(data.length);data.write(type,4,4,'ascii');payload.copy(data,8);return data;
}
test('SC fragments with legacy .ts names advertise their actual MP4 container without altering bytes',()=>{
 const data=Buffer.concat([box('sidx',Buffer.alloc(44)),box('moof',Buffer.alloc(24)),box('mdat',Buffer.from('unchanged media'))]);
 const before=Buffer.from(data);
 assert.equal(hlsSegmentContentType(data,'12.ts'),'video/mp4');assert.deepEqual(data,before);
 assert.equal(hlsSegmentContentType(Buffer.concat([box('free'),box('moof')]),'13.ts'),'video/mp4');
 assert.equal(hlsSegmentContentType(box('ftyp',Buffer.from('iso5')),'init.mp4'),'video/mp4');
});
test('real MPEG-TS and unrecognized or truncated inputs retain the extension fallback',()=>{
 assert.equal(hlsSegmentContentType(Buffer.alloc(188*2,0x47),'1.ts'),'video/mp2t');
 assert.equal(hlsSegmentContentType(Buffer.from('moof'),'2.ts'),'video/mp2t');
 const invalid=box('moof');invalid.writeUInt32BE(999);assert.equal(hlsSegmentContentType(invalid,'3.ts'),'video/mp2t');
 assert.equal(hlsSegmentContentType(Buffer.alloc(0),'init.mp4'),'video/mp4');
});
