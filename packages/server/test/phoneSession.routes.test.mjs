import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createPhoneSessionRoutes, phoneKey } from "../dist/api/providers/phone-session.routes.js";

const post=(url,headers)=>fetch(url,{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify({setup:true})});

async function serve(t, dependencies) {
    const app = express();
    app.use(createPhoneSessionRoutes(dependencies));
    const server = app.listen(0, "127.0.0.1");
    t.after(() => new Promise(resolve => server.close(resolve)));
    await new Promise(resolve => server.once("listening", resolve));
    return `http://127.0.0.1:${server.address().port}/api/tango/phone-session`;
}

test("the phone session needs the key, says whether the PC can log in, and runs one login at a time", async t => {
    let release;
    let logins = 0;
    const cookies = [{ name: "Tango-RT", value: "rt", domain: "gateway.tango.me", path: "/", expires: 1 }];
    const url = await serve(t, {
        key: () => "k".repeat(64),
        available: () => true,
        login: () => { logins++; return new Promise(resolve => { release = () => resolve({ cookies }); }); },
    });
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { "X-Phone-Key": "wrong" } })).status, 401);
    const headers = { "X-Phone-Key": "k".repeat(64) };
    assert.deepEqual(await (await fetch(url, { headers })).json(), { available: true });
    const first = post(url, headers);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await post(url, headers)).status, 409, "a second login waits for the first");
    release();
    assert.deepEqual(await (await first).json(), { cookies });
    assert.equal(logins, 1);
});

test("a PC without the login setup says so; a failed login reports why", async t => {
    const headers = { "X-Phone-Key": "key" };
    const off = await serve(t, { key: () => "key", available: () => false, login: async () => ({ cookies: [] }) });
    assert.equal((await post(off, headers)).status, 503);
    const failing = await serve(t, { key: () => "key", available: () => true, login: async () => { throw new Error("Google asked again"); } });
    const response = await post(failing, headers);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "Google asked again" });
});

test("the phone key is made once, private to the user", async t => {
    const dir = await mkdtemp(path.join(tmpdir(), "phone-key-"));
    t.after(() => rm(dir, { recursive: true }));
    const file = path.join(dir, "tango-phone-key");
    const key = phoneKey(file);
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.equal(phoneKey(file), key);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await readFile(file, "utf-8")).trim(), key);
});

test('a durable request ID rejoins one login and reuses a retained handoff after a lost response',async t=>{
    let release,logins=0;
    const cache=new Map(),id='fixture-request-12345678';
    const result={cookies:[{name:'Tango-ST',value:'access',expires:Date.now()/1000+3600},{name:'Tango-RT',value:'rotated-refresh'}]};
    const deps={key:()=> 'key',available:()=>true,
        retained:id=>cache.get(id),retain:(id,value)=>cache.set(id,value),acknowledge:id=>cache.delete(id),
        login:async()=>{logins++;return new Promise(r=>{release=()=>r(result);});}};
    const url=await serve(t,deps),headers={'X-Phone-Key':'key','X-Phone-Request-ID':id};
    const first=post(url,headers);
    while(!release)await new Promise(r=>setImmediate(r));
    const second=post(url,headers);
    await new Promise(r=>setTimeout(r,30));release();
    assert.deepEqual(await(await first).json(),result);assert.deepEqual(await(await second).json(),result);
    const restored=await serve(t,deps);
    assert.deepEqual(await(await post(restored,headers)).json(),result);
    assert.equal(logins,1);
    assert.equal((await fetch(restored,{method:'DELETE',headers})).status,200);assert.equal(cache.size,0);
});

test('an interrupted initial handoff is returned verbatim even after ST expiry, without consuming its RT',async t=>{
    let given;
    const previous={cookies:[{name:'Tango-ST',value:'expired',expires:1},{name:'Tango-RT',value:'retained-current-refresh'}]};
    let cached=previous;
    const result={cookies:[{name:'Tango-ST',value:'fresh',expires:Date.now()/1000+3600}]};
    const url=await serve(t,{key:()=> 'key',available:()=>true,retained:()=>cached,retain:(_,value)=>{cached=value;},
        login:async refresh=>{given=refresh;return result;}});
    const response=await fetch(url,{method:'POST',headers:{'X-Phone-Key':'key','X-Phone-Request-ID':'fixture-request-12345678','Content-Type':'application/json'},body:JSON.stringify({setup:true,refreshToken:'already-consumed-phone-refresh'})});
    assert.deepEqual(await response.json(),previous);assert.equal(given,undefined);assert.equal(cached,previous);
});
