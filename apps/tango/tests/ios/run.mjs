#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import https from "node:https";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const origin = process.env.IOS_DEBUG_ORIGIN ?? "https://127.0.0.1:36666";
const agent = new https.Agent({ rejectUnauthorized: false });
const commandTimeout = Number(process.env.IOS_TEST_COMMAND_TIMEOUT_MS ?? 45_000);
const connectionTimeout = Number(process.env.IOS_TEST_CONNECTION_TIMEOUT_MS ?? 120_000);
let server = null;
let client = null;

const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

function request(path, { method = "GET", body } = {}) {
    return new Promise((resolveRequest, rejectRequest) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const req = https.request(new URL(path, origin), {
            method,
            agent,
            headers: payload ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
            } : undefined,
        }, response => {
            const chunks = [];
            response.on("data", chunk => chunks.push(chunk));
            response.on("end", () => {
                const text = Buffer.concat(chunks).toString();
                if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
                    rejectRequest(new Error(`${method} ${path}: HTTP ${response.statusCode}: ${text}`));
                    return;
                }
                resolveRequest(text ? JSON.parse(text) : null);
            });
        });
        req.on("error", rejectRequest);
        if (payload) req.write(payload);
        req.end();
    });
}

async function ensureServer() {
    try {
        await request("/__debug_state");
        return;
    } catch {
        server = spawn("python3", [resolve(here, "bridge_server.py")], {
            cwd: root,
            stdio: ["ignore", "ignore", "inherit"],
        });
    }
    for (let attempt = 0; attempt < 40; attempt++) {
        if (server.exitCode !== null) throw new Error("iOS bridge failed to start");
        try {
            await request("/__debug_state");
            return;
        } catch {
            await sleep(250);
        }
    }
    throw new Error("Timed out starting iOS bridge");
}

async function state() {
    return request("/__debug_state");
}

async function postCommand(target, code) {
    return (await request("/__debug_command", {
        method: "POST",
        body: { target, code },
    })).id;
}

async function result(commandId) {
    const deadline = Date.now() + commandTimeout;
    while (Date.now() < deadline) {
        const snapshot = await state();
        const found = [...snapshot.results].reverse().find(item => item.commandId === commandId);
        if (found) {
            if (!found.ok) throw new Error(found.error?.message ?? JSON.stringify(found.error));
            return found.result;
        }
        await sleep(200);
    }
    throw new Error(`Remote command ${commandId} timed out`);
}

async function command(code, expectResult = true) {
    const id = await postCommand(client.client, code);
    return expectResult ? result(id) : id;
}

async function activeClient(predicate) {
    const deadline = Date.now() + connectionTimeout;
    while (Date.now() < deadline) {
        const snapshot = await state();
        const now = Date.now() / 1000;
        const match = [...snapshot.clients]
            .filter(candidate => now - candidate.lastSeen < 3 && predicate(candidate))
            .sort((a, b) => b.lastSeen - a.lastSeen)[0];
        if (match) return match;
        await sleep(250);
    }
    throw new Error("Expected Safari page did not become active");
}

async function foreground() {
    const snapshot = await state();
    const now = Date.now() / 1000;
    const active = snapshot.clients.filter(candidate => now - candidate.lastSeen < 3);
    if (!active.length) throw new Error("No active iPhone debugger");
    const id = await postCommand("*", "return { visible: document.visibilityState === 'visible', focus: document.hasFocus() };");
    for (let attempt = 0; attempt < 30; attempt++) {
        const current = await state();
        const replies = current.results.filter(item => item.commandId === id && item.ok);
        const chosen = replies.find(item => item.result?.visible && item.result?.focus)
            ?? replies.find(item => item.result?.visible);
        if (chosen) {
            const match = active.find(candidate => candidate.client === chosen.client);
            if (match) return match;
        }
        await sleep(100);
    }
    if (active.length === 1) return active[0];
    throw new Error("Could not identify foreground Safari tab");
}

async function navigate(url) {
    await command(`location.href=${JSON.stringify(url)}; return "navigating";`, false);
    const expected = new URL(url);
    client = await activeClient(candidate => {
        const actual = new URL(candidate.href);
        return actual.hostname === expected.hostname
            && actual.pathname === expected.pathname
            && actual.search === expected.search;
    });
}

async function inject(bundle) {
    const id = await postCommand(client.client, `
        const source=${JSON.stringify(bundle)};
        new Function(source + "\\n//# sourceURL=stream-viewer.test.user.js")();
        return source.length;
    `);
    await result(id);
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function local(commandName, args) {
    const completed = spawnSync(commandName, args, { cwd: root, stdio: "inherit" });
    if (completed.error) throw completed.error;
    if (completed.status !== 0) throw new Error(`${commandName} failed`);
}

async function waitForDebugger() {
    const info = await request("/__debug_info");
    console.log(`Waiting for iPhone debugger on port ${new URL(origin).port}.`);
    console.log(`If needed, install:\n  ${info.debuggerUrl}`);
    client = await activeClient(() => true);
    client = await foreground();
    if (new URL(client.href).hostname !== "example.com") {
        throw new Error(`Foreground tab must start at https://example.com/ (found ${client.href})`);
    }
}

async function homeSnapshot() {
    return command(`
        const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
        for(let i=0;i<180&&!document.querySelector(".stream-row")&&!document.querySelector(".status-error");i++) await wait(250);
        const rows=[...document.querySelectorAll(".stream-row")];
        return {
            href:location.href,
            rows:rows.length,
            bodyChildren:document.body.children.length,
            followed:rows.filter(row=>row.querySelector("small")?.textContent==="Following").length,
            firstText:rows[0]?.firstElementChild?.textContent??"",
            firstHref:rows[0]?.href??"",
            firstTop:rows[0]?.getBoundingClientRect().top??null,
            scrollHeight:document.documentElement.scrollHeight,
            viewport:innerHeight,
            error:document.querySelector(".status-error")?.textContent??null,
        };
    `);
}

async function streamSnapshot() {
    return command(`
        const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
        for(let i=0;i<180&&!document.querySelector(".stream-stage")&&!document.querySelector(".status-error");i++) await wait(250);
        for(let i=0;i<120&&(document.querySelectorAll("video")[1]?.readyState??0)<2;i++) await wait(250);
        const slots=[...document.querySelectorAll(".stream-slot")];
        const current=slots[1];
        const video=current?.querySelector("video");
        return {
            href:location.href,
            slots:slots.length,
            loaded:slots.filter(slot=>Boolean(slot.querySelector("video")?.src)).length,
            name:current?.querySelector(".stream-name")?.textContent??"",
            muted:video?.muted??null,
            readyState:video?.readyState??0,
            historyLength:history.length,
            error:document.querySelector(".status-error")?.textContent??null,
        };
    `);
}

async function testGestures() {
    return command(`
        const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
        const stage=document.querySelector(".stream-stage");
        const touch=(x,y,id)=>new Touch({identifier:id,target:stage,clientX:x,clientY:y});
        const fire=(type,touches,changed)=>stage.dispatchEvent(new TouchEvent(type,{touches,changedTouches:changed,bubbles:true,cancelable:true}));
        const shortHref=location.href;
        fire("touchstart",[touch(200,500,1)],[touch(200,500,1)]);
        fire("touchmove",[touch(200,450,1)],[touch(200,450,1)]);
        fire("touchend",[],[touch(200,450,1)]);
        await wait(350);
        const shortStayed=location.href===shortHref;

        fire("touchstart",[touch(300,500,2)],[touch(300,500,2)]);
        fire("touchmove",[touch(150,500,2)],[touch(150,500,2)]);
        fire("touchend",[],[touch(150,500,2)]);
        await wait(80);
        const hidden=document.querySelectorAll(".stream-controls")[1].classList.contains("hidden");
        fire("touchstart",[touch(100,500,3)],[touch(100,500,3)]);
        fire("touchmove",[touch(250,500,3)],[touch(250,500,3)]);
        fire("touchend",[],[touch(250,500,3)]);
        await wait(80);
        const shown=!document.querySelectorAll(".stream-controls")[1].classList.contains("hidden");

        const before={href:location.href,historyLength:history.length};
        fire("touchstart",[touch(200,700,4)],[touch(200,700,4)]);
        fire("touchmove",[touch(200,180,4)],[touch(200,180,4)]);
        fire("touchend",[],[touch(200,180,4)]);
        for(let i=0;i<80&&location.href===before.href;i++) await wait(100);
        await wait(500);
        return {
            shortStayed,hidden,shown,before,
            after:{href:location.href,historyLength:history.length,name:document.querySelectorAll(".stream-name")[1]?.textContent??""},
        };
    `);
}

async function main() {
    await ensureServer();
    await waitForDebugger();
    local("npx", ["tsc", "--noEmit"]);
    local("npx", ["vite", "build"]);
    const bundle = await readFile(resolve(root, "dist/stream-viewer.user.js"), "utf8");

    try {
        await navigate("https://www.tango.me/");
        await inject(bundle);
        const home = await homeSnapshot();
        assert(!home.error, home.error);
        assert(home.rows > 1, "Home did not render streams");
        assert(home.bodyChildren === home.rows, "Home contains non-content elements");
        assert(home.followed > 0 && home.followed < home.rows, "Home is not followed + recommended");
        assert(home.firstText.includes(" "), "Home row does not display alias then name");
        assert(home.scrollHeight > home.viewport, "Home does not use document scrolling");
        console.log(`Home passed: ${home.followed} followed + ${home.rows - home.followed} recommended.`);

        await command(`document.querySelector(".stream-row").click(); return true;`, false);
        client = await activeClient(candidate => new URL(candidate.href).pathname.startsWith("/stream/"));
        await inject(bundle);
        const initial = await streamSnapshot();
        assert(!initial.error, initial.error);
        assert(initial.slots === 3 && initial.loaded >= 2, "Current and adjacent streams were not loaded");
        assert(initial.muted === true, "New stream did not start muted");
        assert(initial.readyState >= 2, "Current stream did not load");
        assert(initial.name.includes(" "), "Stream does not display alias then name");
        console.log("Stream route and adjacent preload passed.");

        const controls = await command(`
            const video=document.querySelectorAll("video")[1];
            const before=video.muted;
            document.querySelectorAll(".mute")[1].click();
            await new Promise(resolve=>setTimeout(resolve,200));
            const toggled=video.muted;
            document.querySelectorAll(".mute")[1].click();
            document.querySelectorAll(".block")[1].click();
            return {before,toggled,restored:video.muted,blockText:document.querySelectorAll(".block")[1].textContent};
        `);
        assert(controls.before !== controls.toggled && controls.restored === controls.before, "Mute did not toggle and restore");
        assert(controls.blockText === "Confirm block", "Block did not require confirmation");

        const gestures = await testGestures();
        assert(gestures.shortStayed, "Short vertical drag navigated");
        assert(gestures.hidden && gestures.shown, "Horizontal control gestures failed");
        assert(gestures.after.href !== gestures.before.href, "Full vertical drag did not navigate");
        assert(gestures.after.historyLength === gestures.before.historyLength, "Vertical navigation added history");
        console.log("Vertical and horizontal gestures passed.");

        const streamUrl = gestures.after.href;
        await navigate(streamUrl);
        await inject(bundle);
        const refreshed = await streamSnapshot();
        assert(refreshed.href === streamUrl, "Stream refresh did not latch onto current URL");
        console.log("Stream refresh passed.");

        await command("history.back(); return true;", false);
        client = await activeClient(candidate => new URL(candidate.href).pathname === "/");
        const restored = await homeSnapshot();
        const aligned = await command(`
            const current=document.querySelector(".stream-row.current");
            return {current:Boolean(current),top:current?.getBoundingClientRect().top??null};
        `);
        assert(aligned.current, "Back did not highlight the last viewed stream");
        assert(Math.abs(aligned.top - home.firstTop) <= 2, `Back aligned stream at ${aligned.top}, expected ${home.firstTop}`);
        assert(restored.rows >= home.rows, "Back lost streams discovered on Stream");
        console.log("Native Back, list synchronization, and scroll alignment passed.");
    } finally {
        try {
            if (new URL(client.href).hostname !== "example.com") await navigate("https://example.com/");
        } catch (error) {
            console.error(`Could not return to example.com: ${error.message}`);
        }
        if (server) server.kill();
    }

    console.log("All stream-viewer iOS tests passed.");
}

main().catch(error => {
    console.error(error);
    if (server) server.kill();
    process.exitCode = 1;
});
