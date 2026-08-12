import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { PendingDirectoryObserver } from "../dist/services/hls/pendingDirectoryObserver.js";

test("provider watches are registered before startup reconciliation", async () => {
    const trace = [];
    const listeners = new Map();
    const observer = new PendingDirectoryObserver(
        ["/library/tslive", "/library/ladder", "/library/fmp4"],
        (candidate) => trace.push(`candidate:${candidate}`),
        () => trace.push("reconcile"),
        (root, error) => trace.push(`error:${root}:${error.message}`),
        {
            watchDirectory(root, listener) {
                trace.push(`watch:${root}`);
                listeners.set(root, listener);
                const watcher = new EventEmitter();
                watcher.close = () => {};
                return watcher;
            },
        },
    );

    await observer.start();
    assert.deepEqual(trace, [
        "watch:/library/tslive",
        "watch:/library/ladder",
        "watch:/library/fmp4",
        "reconcile",
    ]);

    listeners.get("/library/ladder")("rename", "recording");
    listeners.get("/library/ladder")("rename", ".active");
    listeners.get("/library/ladder")("rename", null);
    assert.deepEqual(trace.slice(4), ["candidate:/library/ladder/recording", "reconcile"]);
    observer.close();
});
