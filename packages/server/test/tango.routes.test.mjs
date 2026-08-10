import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createListRoutes } from "../dist/api/providers/list-routes.js";
import { createTangoAdapter } from "../dist/api/providers/tango.routes.js";

test("GET /api/tango/list includes historical aliases from the registry", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "tango-route-"));
    t.after(() => rm(dir, { recursive: true }));
    const filePath = path.join(dir, "tango.txt");
    const accountId = "XRfcVyTyJtbmTzZMRoJ6wg";
    await writeFile(filePath, `https://tango.me/${accountId} bellabr1\n`);

    const aliasLookup = {
        resolve: () => undefined,
        getAllWithHistory: () => ({
            [accountId]: ["nutyipidoras", "bellabr", "bellabr1"],
        }),
        getReverse: () => ({}),
        mergeAliasSnapshot: async () => false,
    };
    const app = express();
    app.use(createListRoutes(createTangoAdapter(filePath, aliasLookup)));
    const server = app.listen(0, "127.0.0.1");
    t.after(() => new Promise(resolve => server.close(resolve)));
    await new Promise(resolve => server.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address === "object");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/tango/list`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [
        accountId,
        "bellabr1",
        "nutyipidoras",
        "bellabr",
    ]);
});

test("POST /api/tango/add resolves registry history, follows the ID, and writes the current alias", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "tango-route-"));
    t.after(() => rm(dir, { recursive: true }));
    const filePath = path.join(dir, "tango.txt");
    const accountId = "DMlfIMFXa86KwjnOom1UzQ";
    const calls = { resolve: [], fetch: [], following: 0, follow: [], merge: [] };
    let aliases = ["uliasamojlenko", "uliasam"];
    const aliasLookup = {
        resolve: id => id === accountId ? "uliasam" : undefined,
        getAllWithHistory: () => ({ [accountId]: aliases }),
        getReverse: () => ({ uliasamojlenko: accountId, uliasam: accountId }),
        mergeAliasSnapshot: async (id, snapshot) => {
            calls.merge.push({ id, snapshot });
            aliases = [...snapshot.history, snapshot.current];
            return false;
        },
    };
    const api = {
        resolveAlias: async input => {
            calls.resolve.push(input);
            return null;
        },
        fetchAliasesInBatch: async ids => {
            calls.fetch.push(ids);
            return {
                [accountId]: {
                    alias: "uliasam",
                    aliases: { current: "uliasam", history: ["uliasamojlenko"] },
                    firstName: "Yliana",
                },
            };
        },
        fetchFollowingAccountIds: async () => {
            calls.following++;
            return [];
        },
        followAccount: async id => calls.follow.push(id),
    };
    const app = express();
    app.use(express.json());
    app.use(createListRoutes(createTangoAdapter(filePath, aliasLookup, api)));
    const server = app.listen(0, "127.0.0.1");
    t.after(() => new Promise(resolve => server.close(resolve)));
    await new Promise(resolve => server.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address === "object");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/tango/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "uliasamojlenko" }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true });
    assert.deepEqual(calls.resolve, [], "Tango alias resolution should not run for registry history");
    assert.deepEqual(calls.fetch, [[accountId]]);
    assert.equal(calls.following, 1);
    assert.deepEqual(calls.follow, [accountId]);
    assert.deepEqual(calls.merge, [{
        id: accountId,
        snapshot: { current: "uliasam", history: ["uliasamojlenko"] },
    }]);
    assert.equal(
        (await import("node:fs/promises").then(fs => fs.readFile(filePath, "utf8"))).trim(),
        `https://tango.me/${accountId} uliasam`,
    );
});

test("POST /api/tango/add does not write the target when following fails", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "tango-route-"));
    t.after(() => rm(dir, { recursive: true }));
    const filePath = path.join(dir, "tango.txt");
    const accountId = "account-id";
    const aliasLookup = {
        resolve: () => undefined,
        getAllWithHistory: () => ({}),
        getReverse: () => ({ oldalias: accountId }),
        mergeAliasSnapshot: async () => true,
    };
    const api = {
        resolveAlias: async () => null,
        fetchAliasesInBatch: async () => ({
            [accountId]: {
                alias: "currentalias",
                aliases: { current: "currentalias", history: ["oldalias"] },
                firstName: null,
            },
        }),
        fetchFollowingAccountIds: async () => [],
        followAccount: async () => { throw new Error("follow unavailable"); },
    };
    const app = express();
    app.use(express.json());
    app.use(createListRoutes(createTangoAdapter(filePath, aliasLookup, api)));
    const server = app.listen(0, "127.0.0.1");
    t.after(() => new Promise(resolve => server.close(resolve)));
    await new Promise(resolve => server.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address === "object");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/tango/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "oldalias" }),
    });

    assert.equal(response.status, 500);
    await assert.rejects(
        import("node:fs/promises").then(fs => fs.readFile(filePath, "utf8")),
        { code: "ENOENT" },
    );
});

test("Tango add skips follow/add when the account is already followed", async () => {
    const accountId = "already-followed";
    const calls = [];
    const aliasLookup = {
        resolve: () => undefined,
        getAllWithHistory: () => ({}),
        getReverse: () => ({}),
        mergeAliasSnapshot: async () => false,
    };
    const api = {
        resolveAlias: async () => null,
        fetchAliasesInBatch: async () => null,
        fetchFollowingAccountIds: async () => [accountId],
        followAccount: async id => calls.push(id),
    };
    const adapter = createTangoAdapter("unused", aliasLookup, api);

    await adapter.beforeAdd({ id: accountId, label: "alias" });

    assert.deepEqual(calls, []);
});
