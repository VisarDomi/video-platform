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
        fetchBlockedAccountIds: async () => ["someone-else"],
        unblockAccount: async () => { throw new Error("only blocked accounts are unblocked"); },
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
        fetchBlockedAccountIds: async () => [],
        unblockAccount: async () => {},
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
        fetchBlockedAccountIds: async () => [],
        unblockAccount: async id => calls.push(`unblock ${id}`),
    };
    const adapter = createTangoAdapter("unused", aliasLookup, api);

    await adapter.beforeAdd({ id: accountId, label: "alias" });

    assert.deepEqual(calls, []);
});

test("Tango add unblocks a blocked account before following it", async () => {
    const accountId = "blocked-account";
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
        fetchFollowingAccountIds: async () => [],
        followAccount: async id => calls.push(`follow ${id}`),
        fetchBlockedAccountIds: async () => [accountId],
        unblockAccount: async id => calls.push(`unblock ${id}`),
    };
    const adapter = createTangoAdapter("unused", aliasLookup, api);

    await adapter.beforeAdd({ id: accountId, label: "alias" });

    assert.deepEqual(calls, [`unblock ${accountId}`, `follow ${accountId}`]);
});

test("Tango add fails before any change when the block state is unknown", async () => {
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
        fetchFollowingAccountIds: async () => [],
        followAccount: async id => calls.push(`follow ${id}`),
        fetchBlockedAccountIds: async () => null,
        unblockAccount: async id => calls.push(`unblock ${id}`),
    };
    const adapter = createTangoAdapter("unused", aliasLookup, api);

    await assert.rejects(adapter.beforeAdd({ id: "account", label: "alias" }), /block state/);
    assert.deepEqual(calls, []);
});

async function listServer(t, adapter) {
    const app = express();
    app.use(express.json());
    app.use(createListRoutes(adapter));
    const server = app.listen(0, "127.0.0.1");
    t.after(() => new Promise(resolve => server.close(resolve)));
    await new Promise(resolve => server.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address === "object");
    return `http://127.0.0.1:${address.port}/api/${adapter.name}`;
}

test("GET member finds a streamer by a listed name at once, and by an old name through the provider", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "member-route-"));
    t.after(() => rm(dir, { recursive: true }));
    const filePath = path.join(dir, "sc.txt");
    await writeFile(filePath, "https://stripchat.com/MMMMMooooooooooo 167036615\n");
    const resolved = [];
    const base = await listServer(t, {
        name: "sc",
        filePath,
        parseLine: line => {
            const match = line.match(/^https:\/\/stripchat\.com\/(\S+) (\d+)$/);
            return match ? { id: match[2], label: match[1] } : null;
        },
        resolveIdentifier: async () => null,
        formatEntry: entry => `https://stripchat.com/${entry.label} ${entry.id}`,
        resolveForRemove: async name => {
            resolved.push(name);
            return name === "momo_love_" ? "167036615" : name;
        },
    });
    const member = async name => (await (await fetch(`${base}/member?identifier=${encodeURIComponent(name)}`)).json()).member;

    assert.equal(await member("MMMMMooooooooooo"), true);
    assert.equal(await member("167036615"), true);
    assert.deepEqual(resolved, [], "A listed name or ID needs no provider lookup");
    assert.equal(await member("momo_love_"), true, "A renamed streamer is still listed");
    assert.equal(await member("someone_else"), false);
    assert.equal((await fetch(`${base}/member`)).status, 400);
});

test("Tango membership resolves a name the registry never saw through Tango", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "member-route-"));
    t.after(() => rm(dir, { recursive: true }));
    const filePath = path.join(dir, "tango.txt");
    const accountId = "A0X2eyW_FIBderJW6Znchg";
    await writeFile(filePath, `https://tango.me/${accountId} rapidgiraffe-3402489\n`);
    const aliasLookup = {
        resolve: () => undefined,
        getAllWithHistory: () => ({}),
        getReverse: () => ({}),
        mergeAliasSnapshot: async () => false,
    };
    const api = {
        resolveAlias: async alias => alias === "rapidgiraffe-3402488" ? { accountId, firstName: "" } : null,
        fetchAliasesInBatch: async () => null,
        fetchFollowingAccountIds: async () => [],
        followAccount: async () => {},
        fetchBlockedAccountIds: async () => [],
        unblockAccount: async () => {},
    };
    const base = await listServer(t, createTangoAdapter(filePath, aliasLookup, api));
    const member = async name => (await (await fetch(`${base}/member?identifier=${encodeURIComponent(name)}`)).json()).member;

    assert.equal(await member("rapidgiraffe-3402488"), true);
    assert.equal(await member("unknown-alias"), false);
});

test("GET exists asks the provider; a lookup that fails is an error, never a miss", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "exists-route-"));
    t.after(() => rm(dir, { recursive: true }));
    const aliasLookup = {
        resolve: () => undefined,
        getAllWithHistory: () => ({}),
        getReverse: () => ({}),
        mergeAliasSnapshot: async () => false,
    };
    let tangoDown = false;
    const api = {
        resolveAlias: async () => null,
        fetchAliasesInBatch: async () => null,
        fetchFollowingAccountIds: async () => [],
        followAccount: async () => {},
        fetchBlockedAccountIds: async () => [],
        unblockAccount: async () => {},
        aliasExists: async alias => {
            if (tangoDown) throw new Error("Tango authentication is unavailable");
            return alias === "lo_vee9";
        },
    };
    const base = await listServer(t, createTangoAdapter(path.join(dir, "tango.txt"), aliasLookup, api));
    const exists = name => fetch(`${base}/exists?identifier=${encodeURIComponent(name)}`);

    assert.deepEqual(await (await exists("lo_vee9")).json(), { exists: true });
    assert.deepEqual(await (await exists("nobody")).json(), { exists: false });
    tangoDown = true;
    const failed = await exists("lo_vee9");
    assert.equal(failed.status, 502);
    assert.deepEqual(await failed.json(), { error: "Tango authentication is unavailable" });
    assert.equal((await fetch(`${base}/exists`)).status, 400);
});
