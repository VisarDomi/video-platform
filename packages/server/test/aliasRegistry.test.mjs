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
        account: ["existing-history", "channel-1101"],
    }));

    const registry = new AliasRegistry(filePath);
    await registry.load();
    await registry.refresh(async () => ({
        account: {
            current: "channel-1101",
            history: ["channel-2622", "channel-1100", " channel-1100 ", ""],
        },
    }), ["account"]);

    assert.equal(registry.resolve("account"), "channel-1101");
    assert.deepEqual(registry.getAllWithHistory().account, [
        "existing-history",
        "channel-2622",
        "channel-1100",
        "channel-1101",
    ]);

    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    assert.deepEqual(persisted.account, registry.getAllWithHistory().account);
});

test("refresh changes current explicitly and deduplicates prior aliases", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "alias-registry-"));
    t.after(() => import("node:fs/promises").then(fs => fs.rm(dir, { recursive: true })));
    const filePath = path.join(dir, "aliases.json");
    await writeFile(filePath, JSON.stringify({ account: ["channel-1100", "channel-1101"] }));

    const registry = new AliasRegistry(filePath);
    await registry.load();
    await registry.refresh(async () => ({
        account: { current: "bellabr2", history: ["channel-1101", "channel-1100"] },
    }), ["account"]);

    assert.equal(registry.resolve("account"), "bellabr2");
    assert.deepEqual(registry.getAllWithHistory().account, ["channel-1100", "channel-1101", "bellabr2"]);
    assert.equal(registry.getReverse().channel-1100, "account");
});

test("loading a cyclic history never mistakes an older alias for current", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "alias-registry-"));
    t.after(() => import("node:fs/promises").then(fs => fs.rm(dir, { recursive: true })));
    const filePath = path.join(dir, "aliases.json");
    await writeFile(filePath, JSON.stringify({
        account: ["channel-1100", "channel-1101", "channel-1100"],
    }));

    const registry = new AliasRegistry(filePath);
    await registry.load();

    assert.equal(registry.resolve("account"), "channel-1100");
    assert.deepEqual(registry.getAllWithHistory().account, ["channel-1101", "channel-1100"]);
});

test("the catalogs' view (AliasBook) answers from the registry without copying it", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "alias-registry-"));
    t.after(() => import("node:fs/promises").then(fs => fs.rm(dir, { recursive: true })));
    const filePath = path.join(dir, "aliases.json");
    await writeFile(filePath, JSON.stringify({ account: ["channel-1100", "channel-1101"], other: ["solo"] }));
    const registry = new AliasRegistry(filePath);
    await registry.load();

    // names(id) is what getAllWithHistory()[id] was for the list routes, one ID at a time.
    for (const [id, names] of Object.entries(registry.getAllWithHistory())) assert.deepEqual(registry.names(id), names);
    assert.equal(registry.names("unknown"), undefined);
    assert.equal(registry.names("constructor"), undefined);
    // The caller gets its own array.
    registry.names("account").push("mutated");
    assert.deepEqual(registry.names("account"), ["channel-1100", "channel-1101"]);
    assert.equal(registry.current("account"), "channel-1101");
    assert.equal(registry.idForName("channel-1100"), "account");
});
