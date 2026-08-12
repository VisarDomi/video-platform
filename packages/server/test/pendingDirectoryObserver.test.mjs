import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { PendingDirectoryObserver } from "../dist/services/hls/pendingDirectoryObserver.js";

test("provider watches are registered before startup reconciliation", async () => {
    const trace = [];
    const listeners = new Map();
    const observer = new PendingDirectoryObserver(
        ["/library/tango", "/library/fc2", "/library/sc"],
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
        "watch:/library/tango",
        "watch:/library/fc2",
        "watch:/library/sc",
        "reconcile",
    ]);

    listeners.get("/library/fc2")("rename", "recording");
    listeners.get("/library/fc2")("rename", ".active");
    listeners.get("/library/fc2")("rename", null);
    assert.deepEqual(trace.slice(4), ["candidate:/library/fc2/recording", "reconcile"]);
    observer.close();
});
