import assert from "node:assert/strict";
import test from "node:test";

import { AccessIncidentTracker } from "../dist/services/download/accessIncidentTracker.js";

test("access incidents aggregate repeated failures and close once", () => {
    const tracker = new AccessIncidentTracker();
    assert.equal(tracker.record({ kind: "http", status: 403 }, 1_000).opened, true);
    assert.equal(tracker.record({ kind: "http", status: 403 }, 2_000).opened, false);
    assert.equal(tracker.record({ kind: "http", status: 404 }, 3_000).opened, false);

    assert.deepEqual(tracker.close("provider-finalized", 4_000), {
        startedAt: 1_000,
        durationMs: 3_000,
        attempts: 3,
        failures: { "http-403": 2, "http-404": 1 },
        firstFailure: { kind: "http", status: 403 },
        lastFailure: { kind: "http", status: 404 },
        outcome: "provider-finalized",
    });
    assert.equal(tracker.close("duplicate-close", 5_000), null);
});

test("a recovered incident does not suppress the next incident", () => {
    const tracker = new AccessIncidentTracker();
    tracker.record({ kind: "network", error: "TimeoutError" }, 10);
    tracker.close("playlist-recovered", 20);
    const next = tracker.record({ kind: "decrypt" }, 30);
    assert.equal(next.opened, true);
    assert.deepEqual(next.snapshot.failures, { decrypt: 1 });
});
