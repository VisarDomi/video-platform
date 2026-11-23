// The core's generic list routes with fake catalogs (the real sites' are tested with their
// plug-ins in private/test).
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createListRoutes } from "../dist/api/providers/list-routes.js";

async function listServer(t, site) {
    const app = express();
    app.use(express.json());
    app.use(createListRoutes(site));
    const server = app.listen(0, "127.0.0.1");
    t.after(() => new Promise(resolve => server.close(resolve)));
    await new Promise(resolve => server.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address === "object");
    return `http://127.0.0.1:${address.port}/api/${site.id}`;
}

test("GET member finds a streamer by a listed name at once, and by an old name through the provider", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "member-route-"));
    t.after(() => rm(dir, { recursive: true }));
    const filePath = path.join(dir, "live-c.txt");
    await writeFile(filePath, "https://live-c.example/centre_court 1001\n");
    const resolved = [];
    const base = await listServer(t, {
        id: "live-c",
        filePath,
        catalog: {
            parseTargetLine: line => {
                const match = line.match(/^https:\/\/live-c\.example\/(\S+) (\d+)$/);
                return match ? { id: match[2], label: match[1] } : null;
            },
            resolveIdentifier: async () => null,
            formatTargetLine: entry => `https://live-c.example/${entry.label} ${entry.id}`,
            resolveForRemove: async name => {
                resolved.push(name);
                return name === "former_name" ? "1001" : name;
            },
        },
    });
    const member = async name => (await (await fetch(`${base}/member?identifier=${encodeURIComponent(name)}`)).json()).member;

    assert.equal(await member("centre_court"), true);
    assert.equal(await member("1001"), true);
    assert.deepEqual(resolved, [], "A listed name or ID needs no provider lookup");
    assert.equal(await member("former_name"), true, "A renamed streamer is still listed");
    assert.equal(await member("someone_else"), false);
    assert.equal((await fetch(`${base}/member`)).status, 400);
});

// "<id> <label>" lines; "?<label>" is an entry without an ID yet.
const catalog = (extra = {}) => ({
    parseTargetLine(line) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return null;
        if (trimmed.startsWith("?")) return { id: "", label: trimmed.slice(1) };
        const [id, label] = trimmed.split(" ");
        return id && label ? { id, label } : null;
    },
    formatTargetLine: ({ id, label }) => `${id} ${label}`,
    resolveIdentifier: async (input) => ({ id: input, label: `${input}-label` }),
    ...extra,
});

test("the list, its entries without an ID, and the catalog's resolveForRemove see the list as it is", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "list-route-"));
    t.after(() => rm(dir, { recursive: true }));
    const filePath = path.join(dir, "demo.txt");
    await writeFile(filePath, "# demo\na1 alpha\n?pending\nb2 beta\n");
    const seen = [];
    const base = await listServer(t, { id: "demo", filePath, catalog: catalog({
        // An unknown name stays itself, as the real sites do when they cannot resolve it.
        resolveForRemove: (identifier, listed) => { seen.push(listed.map(({ id, label }) => `${id}/${label}`)); return identifier; },
    }) });
    assert.deepEqual(await (await fetch(`${base}/list`)).json(), ["alpha", "pending", "beta"]);
    assert.deepEqual(await (await fetch(`${base}/member?identifier=pending`)).json(), { member: true });

    // An entry without an ID is known by its label, as the downloader keys it: removing
    // that name takes its line off the list.
    const removed = await fetch(`${base}/remove`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: "pending" }) });
    assert.equal(removed.status, 200);
    assert.deepEqual(seen, [["a1/alpha", "/pending", "b2/beta"]]);
    assert.equal(await readFile(filePath, "utf-8"), "\n# demo\na1 alpha\nb2 beta\n");
});

test("a site without an existence check answers 501, one without resolution 500", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "list-route-"));
    t.after(() => rm(dir, { recursive: true }));
    const { resolveIdentifier: _unused, ...unresolving } = catalog();
    const base = await listServer(t, { id: "demo", filePath: path.join(dir, "demo.txt"), catalog: unresolving });
    const exists = await fetch(`${base}/exists?identifier=a1`);
    assert.equal(exists.status, 501);
    assert.deepEqual(await exists.json(), { error: "demo cannot look streamers up" });
    assert.equal((await fetch(`${base}/resolve?identifier=a1`)).status, 500);
    const added = await fetch(`${base}/add`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: "a1" }) });
    assert.equal(added.status, 500);
    assert.deepEqual(await (await fetch(`${base}/list`)).json(), []);
});

test("resolve answers the identity, plus the site's pages when its catalog has them", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "list-route-"));
    t.after(() => rm(dir, { recursive: true }));
    const plain = await listServer(t, { id: "demo", filePath: path.join(dir, "demo.txt"), catalog: catalog() });
    assert.deepEqual(await (await fetch(`${plain}/resolve?identifier=a1`)).json(), { id: "a1", label: "a1-label", channelUrl: null, aliasUrl: null });
    const linked = await listServer(t, { id: "live-a", filePath: path.join(dir, "live-a.txt"), catalog: catalog({
        sourceLinks: ({ id, label }) => ({ channelUrl: `http://live-a.test/${id}`, aliasUrl: label === id ? null : `http://live-a.test/@${label}` }),
    }) });
    assert.deepEqual(await (await fetch(`${linked}/resolve?identifier=a1`)).json(),
        { id: "a1", label: "a1-label", channelUrl: "http://live-a.test/a1", aliasUrl: "http://live-a.test/@a1-label" });
    assert.equal((await fetch(`${linked}/resolve?identifier=`)).status, 400);
});
