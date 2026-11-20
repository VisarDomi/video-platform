import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createListRoutes } from "../dist/api/providers/list-routes.js";
import { acquireLock } from "../dist/services/fileLock.js";

async function listServer(t, filePath, resolveDelayMs) {
    const site = {
        id: "demo",
        filePath,
        catalog: {
            parseTargetLine: (line) => {
                const [id, label] = line.trim().split(/\s+/);
                return id && !id.startsWith("#") ? { id, label: label ?? id } : null;
            },
            // A provider lookup takes a while, as the real ones do over the network.
            resolveIdentifier: async (input) => {
                await new Promise((resolve) => setTimeout(resolve, resolveDelayMs(input)));
                return { id: input, label: `${input}-label` };
            },
            formatTargetLine: (entry) => `${entry.id} ${entry.label}`,
        },
    };
    const app = express();
    app.use(express.json());
    app.use(createListRoutes(site));
    const server = app.listen(0, "127.0.0.1");
    t.after(() => new Promise((resolve) => server.close(resolve)));
    await new Promise((resolve) => server.once("listening", resolve));
    return `http://127.0.0.1:${server.address().port}/api/demo`;
}

test("concurrent adds and removes keep every other entry", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "list-durability-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, "demo.txt");
    await writeFile(filePath, "# demo list\nkeep keep-label\ngone gone-label\n");
    const base = await listServer(t, filePath, (input) => (input.charCodeAt(input.length - 1) * 7) % 40);

    const post = (route, identifier) => fetch(`${base}/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier }),
    });
    const ids = Array.from({ length: 12 }, (_, n) => `channel${n}`);
    const responses = await Promise.all([...ids.map((id) => post("add", id)), post("remove", "gone")]);
    for (const response of responses) assert.equal(response.status, 200);

    const lines = (await readFile(filePath, "utf-8")).split("\n").filter(Boolean);
    assert.ok(lines.includes("keep keep-label"));
    assert.ok(!lines.some((line) => line.startsWith("gone ")));
    for (const id of ids) assert.ok(lines.includes(`${id} ${id}-label`), `${id} missing from the list`);
});

test("a list write replaces the file instead of rewriting it in place", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "list-durability-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, "demo.txt");
    await writeFile(filePath, "first first-label\n");
    const before = await stat(filePath);
    const base = await listServer(t, filePath, () => 0);

    const response = await fetch(`${base}/add`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: "second" }),
    });
    assert.equal(response.status, 200);

    // A new inode means readers (and a power cut) see the old list or the new one, never a
    // truncated file being rewritten; and no temporary file is left behind.
    assert.notEqual((await stat(filePath)).ino, before.ino);
    assert.deepEqual(await readdir(dir), ["demo.txt"]);
    // cleanListContent's established format (leading blank line) is unchanged.
    assert.equal(await readFile(filePath, "utf-8"), "\nfirst first-label\nsecond second-label\n");
});

// A site's alias refresh is tested with its plug-in.

test("a lock left without a holder by a power cut is taken over once stale", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "lock-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const lockPath = path.join(dir, "aliases.json.lock");
    // The crash hit between creating the lock directory and writing its holder.
    await mkdir(lockPath);
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    const release = await acquireLock({ lockPath, staleMs: 30_000, timeoutMs: 500 });
    await release();
    assert.deepEqual(await readdir(dir), []);
});

test("a fresh lock without a holder yet is not stolen", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "lock-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const lockPath = path.join(dir, "aliases.json.lock");
    // Another writer has just created the directory and is about to write its holder.
    await mkdir(lockPath);

    await assert.rejects(acquireLock({ lockPath, staleMs: 30_000, timeoutMs: 200 }), /Failed to acquire lock/);
});
