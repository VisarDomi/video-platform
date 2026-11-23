import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createSharedSessionRoutes } from "../dist/api/providers/shared-session.routes.js";

async function serve(t, dependencies, destinationId = "video-host") {
    const app = express();
    app.use(createSharedSessionRoutes(destinationId, dependencies));
    const server = await new Promise((resolve) => {
        const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return `http://127.0.0.1:${server.address().port}/api/${destinationId}/shared-session`;
}

test("shared-session requires X-Phone-Key, sets no-store, and serves only the read-only snapshot", async (t) => {
    let snapshot = null;
    const url = await serve(t, { key: () => "secret-phone-key", read: async () => snapshot });

    const missing = await fetch(url);
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get("cache-control"), "no-store");

    const wrong = await fetch(url, { headers: { "X-Phone-Key": "wrong-key" } });
    assert.equal(wrong.status, 401);

    const unavailable = await fetch(url, { headers: { "X-Phone-Key": "secret-phone-key" } });
    assert.equal(unavailable.status, 503);

    snapshot = {
        cookies: [{ name: "SID", value: "abc123", domain: ".video-host.example", path: "/", secure: true, httpOnly: true }],
        fingerprint: "deadbeef1234",
        savedAt: "2026-11-23T21:00:00.000Z",
    };
    const ok = await fetch(url, { headers: { "X-Phone-Key": "secret-phone-key" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.deepEqual(await ok.json(), snapshot);
});
