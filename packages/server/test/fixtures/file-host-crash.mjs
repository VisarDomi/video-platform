import { FileHostDownloads } from '../../dist/services/fileHostDownloads.js';
import { host } from '../support/fileHost.mjs';
const options=JSON.parse(process.argv[2]);
const size=10*1024*1024;
const fetcher=async input=>{
    const url=new URL(input);
    if(url.pathname.startsWith('/f/'))return new Response('<a href="https://dl.files.example/file/42">Download</a>');
    if(url.pathname==='/api/file')return Response.json({mediafiles:'https://edge.cdn.files.example',path:'/video.mp4',original:'crash.mp4'});
    if(url.pathname==='/sign')return Response.json({token:'test',ex:12345});
    let stage=0;
    return new Response(new ReadableStream({async pull(controller){
        if(stage===0){stage++;controller.enqueue(new Uint8Array(8*1024*1024).fill(97));return;}
        if(stage===1){stage++;controller.enqueue(new Uint8Array(1024*1024).fill(97));return;}
        await new Promise(resolve=>setTimeout(resolve,200));
        console.log('STREAMING');
        await new Promise(()=>{});
    }}),{headers:{'content-length':String(size),etag:'"same"'}});
};
const queue=new FileHostDownloads(host,{...options,fetcher,autoStart:false});
await queue.enqueue('https://files.example/f/Fixture42');
console.log('ACCEPTED');
await queue.runPending();
