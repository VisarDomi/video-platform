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
        account: ["existing-history", "bellabr1"],
    }));

    const registry = new AliasRegistry(filePath);
    await registry.load();
    await registry.refresh(async () => ({
        account: {
            current: "bellabr1",
            history: ["nutyipidoras", "bellabr", " bellabr ", ""],
        },
    }), ["account"]);

    assert.equal(registry.resolve("account"), "bellabr1");
    assert.deepEqual(registry.getAllWithHistory().account, [
        "existing-history",
        "nutyipidoras",
        "bellabr",
        "bellabr1",
    ]);

    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    assert.deepEqual(persisted.account, registry.getAllWithHistory().account);
});

test("refresh changes current explicitly and deduplicates prior aliases", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "alias-registry-"));
    t.after(() => import("node:fs/promises").then(fs => fs.rm(dir, { recursive: true })));
    const filePath = path.join(dir, "aliases.json");
    await writeFile(filePath, JSON.stringify({ account: ["bellabr", "bellabr1"] }));

    const registry = new AliasRegistry(filePath);
    await registry.load();
    await registry.refresh(async () => ({
        account: { current: "bellabr2", history: ["bellabr1", "bellabr"] },
    }), ["account"]);

    assert.equal(registry.resolve("account"), "bellabr2");
    assert.deepEqual(registry.getAllWithHistory().account, ["bellabr", "bellabr1", "bellabr2"]);
    assert.equal(registry.getReverse().bellabr, "account");
});

test("loading a cyclic history never mistakes an older alias for current", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "alias-registry-"));
    t.after(() => import("node:fs/promises").then(fs => fs.rm(dir, { recursive: true })));
    const filePath = path.join(dir, "aliases.json");
    await writeFile(filePath, JSON.stringify({
        account: ["bellabr", "bellabr1", "bellabr"],
    }));

    const registry = new AliasRegistry(filePath);
    await registry.load();

    assert.equal(registry.resolve("account"), "bellabr");
    assert.deepEqual(registry.getAllWithHistory().account, ["bellabr1", "bellabr"]);
});
