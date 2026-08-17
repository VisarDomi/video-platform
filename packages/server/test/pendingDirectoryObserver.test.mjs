import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { PendingDirectoryObserver } from "../dist/services/hls/pendingDirectoryObserver.js";

test("handoff mailboxes are watched directly and non-recursively", async () => {
    const trace = [];
    const listeners = new Map();
    const observer = new PendingDirectoryObserver(
        ["/library/tslive/.pending", "/library/ladder/.pending"],
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
        "watch:/library/tslive/.pending",
        "watch:/library/ladder/.pending",
        "reconcile",
    ]);

    listeners.get("/library/ladder/.pending")("rename", "recording");
    listeners.get("/library/ladder/.pending")("rename", "recording/segment.ts");
    listeners.get("/library/ladder/.pending")("rename", null);
    assert.deepEqual(trace.slice(3), [
        "candidate:/library/ladder/.pending/recording",
        "reconcile",
    ]);
    observer.close();
});
