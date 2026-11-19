import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FilePluginStore, loadSites, parseSitesFile, readSitesFile, sitesWith, SDK_VERSION } from "../dist/index.js";

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
    assert.deepEqual(parseSitesFile('{"sites":[{"id":"a","plugin":"p","label":"Site A"}]}'),
        [{ id: "a", plugin: "p", label: "Site A", enabled: true, config: {} }]);
    assert.throws(() => parseSitesFile('{"sites":[{"id":"a","plugin":"p","label":" "}]}'), /label must be/);
    assert.throws(() => parseSitesFile('{"sites":[{"id":"a","plugin":"p","label":1}]}'), /label must be/);
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
