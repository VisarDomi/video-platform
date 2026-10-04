import assert from "node:assert/strict";
import test from "node:test";

import { resolveScUsername } from "../dist/services/sc/apiClient.js";

test("Stripchat usernames resolve through the current user-ID endpoint", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });

    let requestedUrl = "";
    globalThis.fetch = async (url) => {
        requestedUrl = String(url);
        return new Response(JSON.stringify({ id: 167036615 }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    };

    assert.deepEqual(await resolveScUsername("momo love"), {
        username: "momo love",
        roomId: "167036615",
    });
    assert.equal(
        requestedUrl,
        "https://stripchat.com/api/front/users/user-ids/momo%20love",
    );
});

test("An old Stripchat username resolves to its room and current username", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async () => new Response(JSON.stringify({ id: 167036615, newUsername: "MMMMMooooooooooo" }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });

    assert.deepEqual(await resolveScUsername("momo_love_"), {
        username: "MMMMMooooooooooo",
        roomId: "167036615",
    });
});

test("Stripchat username resolution rejects unsuccessful lookups", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async () => new Response(null, { status: 404 });

    assert.equal(await resolveScUsername("missing_model"), null);
});

test("Stripchat existence: a model is found, an unknown name is not, a failure is an error", async (t) => {
    const { scUsernameExists } = await import("../dist/services/sc/apiClient.js");
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    let status = 200;
    globalThis.fetch = async () => status === 200
        ? new Response(JSON.stringify({ id: 167036615, newUsername: "MMMMMooooooooooo" }), { status })
        : new Response(null, { status });

    assert.equal(await scUsernameExists("momo_love_"), true);
    status = 404;
    assert.equal(await scUsernameExists("nobody_here"), false);
    status = 503;
    await assert.rejects(scUsernameExists("anyone"), /Stripchat lookup failed: 503/);
});

test("FC2 existence: FC2 answers every number, with an empty profile for a missing channel", async (t) => {
    const { fc2ChannelExists } = await import("../dist/services/fc2/apiClient.js");
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    const requests = [];
    let reply = { status: 1, data: { channel_data: { channelid: "12830257" }, profile_data: { userid: "12830257" } } };
    globalThis.fetch = async (url, init) => {
        requests.push(String(init.body));
        return reply ? new Response(JSON.stringify(reply), { status: 200 }) : new Response(null, { status: 500 });
    };

    assert.equal(await fc2ChannelExists("12830257"), true);
    reply = { status: 1, data: { channel_data: { channelid: "999999999" }, profile_data: { userid: "" } } };
    assert.equal(await fc2ChannelExists("999999999"), false);
    assert.equal(await fc2ChannelExists("kaaysi"), false, "Channel IDs are numbers");
    assert.equal(requests.length, 2, "A name that is no number needs no request");
    reply = null;
    await assert.rejects(fc2ChannelExists("1"), /FC2 lookup failed: 500/);
});
