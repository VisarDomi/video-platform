import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { PendingDirectoryObserver } from "../dist/services/hls/pendingDirectoryObserver.js";

test("handoff mailboxes are watched directly and non-recursively", async () => {
    const trace = [];
    const listeners = new Map();
    const observer = new PendingDirectoryObserver(
        ["/library/tango/.pending", "/library/fc2/.pending"],
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
        "watch:/library/tango/.pending",
        "watch:/library/fc2/.pending",
        "reconcile",
    ]);

    listeners.get("/library/fc2/.pending")("rename", "recording");
    listeners.get("/library/fc2/.pending")("rename", "recording/segment.ts");
    listeners.get("/library/fc2/.pending")("rename", null);
    assert.deepEqual(trace.slice(3), [
        "candidate:/library/fc2/.pending/recording",
        "reconcile",
    ]);
    observer.close();
});
