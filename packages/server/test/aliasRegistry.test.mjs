import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AliasRegistry } from "../dist/services/aliasRegistry.js";

test("refresh merges fetched history while preserving the fetched current alias", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "alias-registry-"));
    t.after(() => import("node:fs/promises").then(fs => fs.rm(dir, { recursive: true })));
    const filePath = path.join(dir, "aliases.json");
    await writeFile(filePath, JSON.stringify({
        account: ["existing-history", "court_a1"],
    }));

    const registry = new AliasRegistry(filePath);
    await registry.load();
    await registry.refresh(async () => ({
        account: {
            current: "court_a1",
            history: ["former_court", "court_a", " court_a ", ""],
        },
    }), ["account"]);

    assert.equal(registry.resolve("account"), "court_a1");
    assert.deepEqual(registry.getAllWithHistory().account, [
        "existing-history",
        "former_court",
        "court_a",
        "court_a1",
    ]);

    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    assert.deepEqual(persisted.account, registry.getAllWithHistory().account);
});

test("refresh changes current explicitly and deduplicates prior aliases", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "alias-registry-"));
    t.after(() => import("node:fs/promises").then(fs => fs.rm(dir, { recursive: true })));
    const filePath = path.join(dir, "aliases.json");
    await writeFile(filePath, JSON.stringify({ account: ["court_a", "court_a1"] }));

    const registry = new AliasRegistry(filePath);
    await registry.load();
    await registry.refresh(async () => ({
        account: { current: "court_a2", history: ["court_a1", "court_a"] },
    }), ["account"]);

    assert.equal(registry.resolve("account"), "court_a2");
    assert.deepEqual(registry.getAllWithHistory().account, ["court_a", "court_a1", "court_a2"]);
    assert.equal(registry.getReverse().court_a, "account");
});

test("loading a cyclic history never mistakes an older alias for current", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "alias-registry-"));
    t.after(() => import("node:fs/promises").then(fs => fs.rm(dir, { recursive: true })));
    const filePath = path.join(dir, "aliases.json");
    await writeFile(filePath, JSON.stringify({
        account: ["court_a", "court_a1", "court_a"],
    }));

    const registry = new AliasRegistry(filePath);
    await registry.load();

    assert.equal(registry.resolve("account"), "court_a");
    assert.deepEqual(registry.getAllWithHistory().account, ["court_a1", "court_a"]);
});

test("the catalogs' view (AliasBook) answers from the registry without copying it", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "alias-registry-"));
    t.after(() => import("node:fs/promises").then(fs => fs.rm(dir, { recursive: true })));
    const filePath = path.join(dir, "aliases.json");
    await writeFile(filePath, JSON.stringify({ account: ["court_a", "court_a1"], other: ["solo"] }));
    const registry = new AliasRegistry(filePath);
    await registry.load();

    // names(id) is what getAllWithHistory()[id] was for the list routes, one ID at a time.
    for (const [id, names] of Object.entries(registry.getAllWithHistory())) assert.deepEqual(registry.names(id), names);
    assert.equal(registry.names("unknown"), undefined);
    assert.equal(registry.names("constructor"), undefined);
    // The caller gets its own array.
    registry.names("account").push("mutated");
    assert.deepEqual(registry.names("account"), ["court_a", "court_a1"]);
    assert.equal(registry.current("account"), "court_a1");
    assert.equal(registry.idForName("court_a"), "account");
});
