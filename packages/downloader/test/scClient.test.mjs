import assert from "node:assert/strict";
import test from "node:test";

import { ScClient } from "../dist/services/sc/api/scClient.js";

test("Stripchat target refresh uses the room-ID cam endpoint", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });

    let requestedUrl = "";
    globalThis.fetch = async (url) => {
        requestedUrl = String(url);
        return new Response(JSON.stringify({
            cam: {
                streamName: "stream-167036615",
                isCamAvailable: true,
                isCamActive: true,
            },
            user: {
                user: {
                    id: 167036615,
                    username: "momo_love_",
                    statusChangedAt: "2026-08-27T11:14:39Z",
                },
            },
        }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    };

    const client = new ScClient();
    assert.deepEqual(await client.refreshTarget("167036615", "old_alias"), {
        roomId: "167036615",
        username: "momo_love_",
        streamName: "stream-167036615",
        statusChangedAt: "2026-08-27T111439Z",
    });
    assert.equal(
        requestedUrl,
        "https://stripchat.com/api/front/v2/models/167036615/cam",
    );
});

test("Stripchat target refresh rejects a mismatched room identity", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async () => new Response(JSON.stringify({
        cam: { streamName: "wrong", isCamAvailable: true, isCamActive: true },
        user: { user: { id: 999, username: "wrong_model" } },
    }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });

    const client = new ScClient();
    assert.equal(await client.refreshTarget("167036615", "momo_love_"), null);
});
