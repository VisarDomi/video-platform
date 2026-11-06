import test from 'node:test';
import assert from 'node:assert/strict';
import {Fc2Client} from '../dist/services/fc2/api/fc2Client.js';

function setup(t){
    t.mock.timers.enable({apis:['setTimeout','setInterval']});
    const sockets=[];
    class Socket{
        constructor(){this.sent=[];sockets.push(this);}
        send(raw){this.sent.push(JSON.parse(raw));}
        close(){this.closed=true;}
        emit(name,args={},id){this.onmessage({data:JSON.stringify({name,arguments:args,id})});}
    }
    const original=globalThis.WebSocket;globalThis.WebSocket=Socket;t.after(()=>{globalThis.WebSocket=original;});
    const client=Object.assign(Object.create(Fc2Client.prototype),{msgId:0,sessions:new Map()});
    t.after(()=>{for(const id of [...client.sessions.keys()])client._closeSession(id);});
    const begin=(id,connect=true)=>{const result=client._performWsHandshake('wss://fixture.invalid',id);const socket=sockets.at(-1);if(connect)socket.emit('connect_complete');return{result,socket,request:socket.sent.at(-1)?.id};};
    const reply=(request,name)=>request.socket.emit('_response_',{playlists:[{url:'https://fixture.invalid/'+name+'.m3u8',mode:52}]},request.request);
    return{client,begin,reply};
}

test('FC2 matches overlapping handshakes to each socket request, regardless of response order',async t=>{
    const {begin,reply}=setup(t);const first=begin('first'),second=begin('second');
    reply(second,'second');reply(first,'first');t.mock.timers.tick(15000);
    assert.deepEqual(await Promise.all([first.result,second.result]),['https://fixture.invalid/first.m3u8','https://fixture.invalid/second.m3u8']);
});

test('another FC2 channel heartbeat cannot invalidate a pending HLS reply',async t=>{
    const {begin,reply,client}=setup(t);const first=begin('first');reply(first,'first');await first.result;
    t.mock.timers.tick(25000);const second=begin('second');t.mock.timers.tick(5000);
    assert.ok(client.msgId>second.request,'fixture must interleave an existing socket heartbeat');
    reply(second,'second');t.mock.timers.tick(15000);
    assert.equal(await second.result,'https://fixture.invalid/second.m3u8');
});

test('FC2 does not accept an unsolicited reply before sending its HLS request',async t=>{
    const {begin,reply}=setup(t);const first=begin('first',false);let resolved=false;
    first.result.then(()=>{resolved=true;});
    first.socket.emit('_response_',{playlists:[{url:'https://fixture.invalid/unrequested.m3u8',mode:52}]},0);
    await Promise.resolve();assert.equal(resolved,false);
    first.socket.emit('connect_complete');first.request=first.socket.sent.at(-1).id;reply(first,'first');
    assert.equal(await first.result,'https://fixture.invalid/first.m3u8');
});

test('a replaced FC2 socket cannot close its newer session on a late close event',async t=>{
    const {begin,reply,client}=setup(t);const old=begin('channel');reply(old,'old');await old.result;
    const current=begin('channel');reply(current,'current');await current.result;
    old.socket.onclose();
    assert.equal(client.sessions.get('channel')?.ws,current.socket);
    assert.equal(current.socket.closed,undefined);
});
