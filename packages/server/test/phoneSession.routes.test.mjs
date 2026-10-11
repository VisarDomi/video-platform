import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createPhoneSessionRoutes, phoneKey } from "../dist/api/providers/phone-session.routes.js";

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
    const first = fetch(url, { method: "POST", headers });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await fetch(url, { method: "POST", headers })).status, 409, "a second login waits for the first");
    release();
    assert.deepEqual(await (await first).json(), { cookies });
    assert.equal(logins, 1);
});

test("a PC without the login setup says so; a failed login reports why", async t => {
    const headers = { "X-Phone-Key": "key" };
    const off = await serve(t, { key: () => "key", available: () => false, login: async () => ({ cookies: [] }) });
    assert.equal((await fetch(off, { method: "POST", headers })).status, 503);
    const failing = await serve(t, { key: () => "key", available: () => true, login: async () => { throw new Error("Google asked again"); } });
    const response = await fetch(failing, { method: "POST", headers });
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
