import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FilePluginStore, loadSites, parseFileHosts, parseSitesFile, parseUplink, readSitesFile, sitesWith, SDK_VERSION } from "../dist/index.js";

test("the store replaces values durably and leaves no temporary files", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "sdk-store-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const store = new FilePluginStore(path.join(dir, "state"));

    assert.equal(await store.read("session"), undefined);
    await store.write("session", { token: "a" });
    assert.deepEqual(await store.read("session"), { token: "a" });
    assert.deepEqual(await readdir(path.join(dir, "state")), ["session.json"]);
    await store.delete("session");
    assert.equal(await store.read("session"), undefined);
});

test("concurrent updates of one key are serialized", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "sdk-store-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const store = new FilePluginStore(dir);

    await Promise.all(Array.from({ length: 25 }, () => store.update("count", (n) => (n ?? 0) + 1)));
    assert.equal(await store.read("count"), 25);
});

test("store keys cannot escape the state directory", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "sdk-store-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const store = new FilePluginStore(dir);
    await assert.rejects(store.write("../escape", 1), /Invalid store key/);
    await assert.rejects(store.read("a/b"), /Invalid store key/);
});

test("the sites file is validated", () => {
    assert.deepEqual(parseSitesFile('{"sites":[{"id":"live-a","plugin":"p"}]}'),
        [{ id: "live-a", plugin: "p", enabled: true, config: {} }]);
    assert.throws(() => parseSitesFile("{"), /invalid JSON/);
    assert.throws(() => parseSitesFile('{"sites":{}}'), /expected/);
    assert.throws(() => parseSitesFile('{"sites":[{"id":"Live A","plugin":"p"}]}'), /invalid id/);
    assert.throws(() => parseSitesFile('{"sites":[{"id":"a","plugin":"p"},{"id":"a","plugin":"q"}]}'), /duplicate id/);
    assert.throws(() => parseSitesFile('{"sites":[{"id":"a"}]}'), /plugin is required/);
    assert.throws(() => parseSitesFile('{"sites":[{"id":"a","plugin":"p","config":[]}]}'), /config must be an object/);
});

test("a missing sites file is an error, never an empty deployment", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "sdk-sites-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await assert.rejects(readSitesFile(path.join(dir, "sites.json")), /ENOENT/);
    await writeFile(path.join(dir, "sites.json"), '{"sites":[]}');
    assert.deepEqual(await readSitesFile(path.join(dir, "sites.json")), []);
});

test("plug-ins load per site, skip disabled sites and check the SDK version", async () => {
    const created = [];
    const plugin = {
        id: "demo",
        sdkVersion: SDK_VERSION,
        create: (context) => {
            created.push(context.siteId);
            return { capture: context.siteId === "a" ? { pollIntervalMs: 1000 } : undefined };
        },
    };
    const modules = { good: { plugin }, old: { default: { ...plugin, sdkVersion: 0 } }, none: {} };
    const importPlugin = async (name) => modules[name];
    const context = (entry) => ({ siteId: entry.id, config: entry.config });

    const sites = await loadSites(parseSitesFile(JSON.stringify({ sites: [
        { id: "a", plugin: "good" },
        { id: "b", plugin: "good" },
        { id: "c", plugin: "good", enabled: false },
    ] })), { importPlugin, context });
    assert.deepEqual(sites.map((site) => site.id), ["a", "b"]);
    assert.deepEqual(created, ["a", "b"]);
    assert.deepEqual(sitesWith(sites, "capture").map((site) => site.id), ["a"]);

    await assert.rejects(loadSites([{ id: "x", plugin: "old" }], { importPlugin, context }), /targets SDK 0/);
    await assert.rejects(loadSites([{ id: "y", plugin: "none" }], { importPlugin, context }), /does not export a plug-in/);
});

test("a site may name the account its consumers read; a site with auth must", async () => {
    assert.deepEqual(parseSitesFile('{"sites":[{"id":"a","plugin":"p","account":"someone@example.invalid"}]}'),
        [{ id: "a", plugin: "p", enabled: true, account: "someone@example.invalid", config: {} }]);
    assert.throws(() => parseSitesFile('{"sites":[{"id":"a","plugin":"p","account":""}]}'), /account must be/);
    assert.throws(() => parseSitesFile('{"sites":[{"id":"a","plugin":"p","account":"../escape"}]}'), /account must be/);
    const plugin = { id: "demo", label: "Demo", sdkVersion: SDK_VERSION, create: () => ({ auth: {} }) };
    const importPlugin = async () => ({ plugin });
    const context = (entry) => ({ siteId: entry.id });
    await assert.rejects(loadSites([{ id: "a", plugin: "demo" }], { importPlugin, context }), /needs an "account"/);
    assert.equal((await loadSites([{ id: "a", plugin: "demo", account: "x" }], { importPlugin, context })).length, 1);
});

test("a failed load closes the instances it already created, so the process can exit", async () => {
    const closed = [];
    const good = { id: "demo", label: "Demo", sdkVersion: SDK_VERSION, create: (context) => ({ close: () => { closed.push(context.siteId); } }) };
    const withAuth = { ...good, create: (context) => ({ auth: {}, close: () => { closed.push(context.siteId); } }) };
    const modules = { good: { plugin: good }, auth: { plugin: withAuth }, none: {} };
    const importPlugin = async (name) => modules[name];
    const context = (entry) => ({ siteId: entry.id });

    await assert.rejects(loadSites([{ id: "a", plugin: "good" }, { id: "b", plugin: "good" }, { id: "c", plugin: "none" }],
        { importPlugin, context }), /does not export a plug-in/);
    assert.deepEqual(closed, ["a", "b"]);

    closed.length = 0;
    // The instance that failed the account check is closed too.
    await assert.rejects(loadSites([{ id: "a", plugin: "good" }, { id: "t", plugin: "auth" }], { importPlugin, context }),
        /needs an "account"/);
    assert.deepEqual(closed.sort(), ["a", "t"]);
});

test("file hosts: ports besides HTTPS's default only as the entry's own distinct list", () => {
    const parse = (entry) => parseFileHosts(JSON.stringify({ fileHosts: [{ id: "file-host", plugin: "plugin-file-host", ...entry }] }));
    assert.deepEqual(parse({}), [{ id: "file-host", plugin: "plugin-file-host" }]);
    assert.deepEqual(parse({ allowPorts: [18084, 18085], config: { origin: "https://127.0.0.1:18084" } }),
        [{ id: "file-host", plugin: "plugin-file-host", config: { origin: "https://127.0.0.1:18084" }, allowPorts: [18084, 18085] }]);
    for (const allowPorts of [[], [0], [65536], [1.5], ["18084"], [443], [80, 80], "18084"]) {
        assert.throws(() => parse({ allowPorts }), /allowPorts/, JSON.stringify(allowPorts));
    }
    assert.deepEqual(parseFileHosts(JSON.stringify({ sites: [] })), []);
});

test("uplink: optional; one labelled drive or a directory, a gateway or a probe, a runner command", () => {
    assert.equal(parseUplink(JSON.stringify({ sites: [] })), null);
    const base = { id: "office", dailyBytes: 50, network: { gateway: "AA:BB:CC:DD:EE:FF" },
        carrier: { label: "CARRIER1", capacityBytes: 230, remoteMount: "/Volumes/CARRIER1" }, runner: ["ssh", "mac", "node", "r.js"] };
    const parse = (uplink) => parseUplink(JSON.stringify({ uplink, sites: [] }), "sites.json");
    assert.deepEqual(parse(base), { id: "office", dailyBytes: 50, network: { gateway: "aa:bb:cc:dd:ee:ff" },
        carrier: { label: "CARRIER1", capacityBytes: 230, remoteMount: "/Volumes/CARRIER1" }, runner: ["ssh", "mac", "node", "r.js"],
        minFreeBytes: 100_000_000_000 });
    assert.deepEqual(parse({ ...base, network: { gateway: "x", probe: ["cat", "/tmp/net"] }, carrier: { path: "/tmp/carrier", capacityBytes: 5 }, minFreeBytes: 7 }),
        { id: "office", dailyBytes: 50, network: { gateway: "x", probe: ["cat", "/tmp/net"] },
            carrier: { path: "/tmp/carrier", capacityBytes: 5, remoteMount: "/tmp/carrier" }, runner: ["ssh", "mac", "node", "r.js"], minFreeBytes: 7 });
    for (const [bad, message] of [
        [{ ...base, id: "home" }, /"home" is the PC's own network/],
        [{ ...base, id: "Office" }, /invalid id/],
        [{ ...base, dailyBytes: 0 }, /dailyBytes must be a positive integer/],
        [{ ...base, network: {} }, /gateway is required/],
        [{ ...base, network: { gateway: "x", probe: [] } }, /probe must be a non-empty list/],
        [{ ...base, carrier: { capacityBytes: 1, remoteMount: "/x" } }, /either label or path/],
        [{ ...base, carrier: { label: "A", path: "/x", capacityBytes: 1 } }, /either label or path/],
        [{ ...base, carrier: { label: "has space", capacityBytes: 1, remoteMount: "/x" } }, /label must be/],
        [{ ...base, carrier: { path: "relative", capacityBytes: 1 } }, /path must be absolute/],
        [{ ...base, carrier: { label: "A", capacityBytes: 1 } }, /remoteMount must be an absolute path/],
        [{ ...base, runner: "ssh mac" }, /runner must be a non-empty list/],
        [{ ...base, extra: 1 }, /unknown key extra/],
        ["office", /uplink must be an object/],
    ]) assert.throws(() => parse(bad), message, JSON.stringify(bad));
    assert.throws(() => parse({ ...base, dailyBytes: -1 }), /^Error: sites.json: uplink: dailyBytes/);
});
