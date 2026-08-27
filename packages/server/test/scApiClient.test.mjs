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

test("Stripchat username resolution rejects unsuccessful lookups", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async () => new Response(null, { status: 404 });

    assert.equal(await resolveScUsername("missing_model"), null);
});
