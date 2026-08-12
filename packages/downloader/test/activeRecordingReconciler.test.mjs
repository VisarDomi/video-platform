import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ActiveRecordingReconciler } from "../dist/services/common/activeRecordingReconciler.js";
import { formatSegmentName } from "../dist/services/download/segmentIdentity.js";

async function fixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-platform-active-"));
    t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
    const finalizedRoot = path.join(root, "fc2", "downloader");
    const activeRoot = path.join(finalizedRoot, ".active");
    const pendingRoot = path.join(finalizedRoot, ".pending");
    const name = "2026-08-12 090000 12345";
    const recordingPath = path.join(activeRoot, name);
    await mkdir(recordingPath, { recursive: true });
    const segmentName = formatSegmentName(0, "start-1", 99);
    await writeFile(path.join(recordingPath, segmentName), "media");
    await writeFile(path.join(recordingPath, "playlist.m3u8"), [
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:1",
        "#EXTINF:1,",
        segmentName,
        "",
    ].join("\n"));
    const manager = {
        hasStreamer: () => false,
        finalizeStreamer: async () => false,
    };
    return {
        finalizedRoot,
        activeRoot,
        pendingRoot,
        name,
        recordingPath,
        reconciler: new ActiveRecordingReconciler("fc2", manager, (alias) => alias, activeRoot),
    };
}

test("same recording identity is offered for resume", async (t) => {
    const value = await fixture(t);
    const result = await value.reconciler.reconcile({
        observedAt: 0,
        live: new Map([["12345", {
            targetId: "12345",
            alias: "12345",
            recordingId: "start-1",
            masterPlaylistUrl: "https://example.test/master.m3u8",
        }]]),
        terminalTargetIds: new Set(),
    });
    assert.equal(result.resumePaths.get("12345"), value.recordingPath);
});

test("the folder target wins when another FC2 channel shares its start_time", async (t) => {
    const value = await fixture(t);
    const result = await value.reconciler.reconcile({
        observedAt: 0,
        live: new Map([
            ["99999", {
                targetId: "99999",
                alias: "99999",
                recordingId: "start-1",
                masterPlaylistUrl: "https://example.test/wrong.m3u8",
            }],
            ["12345", {
                targetId: "12345",
                alias: "12345",
                recordingId: "start-1",
                masterPlaylistUrl: "https://example.test/right.m3u8",
            }],
        ]),
        terminalTargetIds: new Set(),
    });
    assert.equal(result.resumePaths.get("12345"), value.recordingPath);
    assert.equal(result.resumePaths.has("99999"), false);
});

test("terminal state needs successful observations spanning sixty seconds", async (t) => {
    const value = await fixture(t);
    const terminal = (observedAt) => ({
        observedAt,
        live: new Map(),
        terminalTargetIds: new Set(["12345"]),
    });
    await value.reconciler.reconcile(terminal(0));
    await value.reconciler.reconcile(terminal(30_000));
    await stat(value.recordingPath);
    await value.reconciler.reconcile(terminal(60_000));
    await assert.rejects(stat(value.recordingPath), { code: "ENOENT" });
    const pendingPath = path.join(value.pendingRoot, value.name);
    assert.match(await readFile(path.join(pendingPath, "playlist.m3u8"), "utf8"), /#EXT-X-ENDLIST\n$/);
    await assert.rejects(stat(path.join(value.finalizedRoot, value.name)), { code: "ENOENT" });
});

test("a different identity finalizes immediately", async (t) => {
    const value = await fixture(t);
    await value.reconciler.reconcile({
        observedAt: 0,
        live: new Map([["12345", {
            targetId: "12345",
            alias: "12345",
            recordingId: "start-2",
            masterPlaylistUrl: "https://example.test/new.m3u8",
        }]]),
        terminalTargetIds: new Set(),
    });
    await assert.rejects(stat(value.recordingPath), { code: "ENOENT" });
    await stat(path.join(value.pendingRoot, value.name));
    await assert.rejects(stat(path.join(value.finalizedRoot, value.name)), { code: "ENOENT" });
});

test("startup completes an interrupted ENDLIST handoff without publishing it", async (t) => {
    const value = await fixture(t);
    await writeFile(path.join(value.recordingPath, "playlist.m3u8"), [
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:1",
        "#EXTINF:1,",
        formatSegmentName(0, "start-1", 99),
        "#EXT-X-ENDLIST",
        "",
    ].join("\n"));
    await value.reconciler.recoverLocalState();
    await assert.rejects(stat(value.recordingPath), { code: "ENOENT" });
    await stat(path.join(value.pendingRoot, value.name));
    await assert.rejects(stat(path.join(value.finalizedRoot, value.name)), { code: "ENOENT" });
});

test("a first segment persisted before playlist creation remains resumable", async (t) => {
    const value = await fixture(t);
    await import("node:fs/promises").then(({ rm }) => rm(path.join(value.recordingPath, "playlist.m3u8")));
    const result = await value.reconciler.reconcile({
        observedAt: 0,
        live: new Map([["12345", {
            targetId: "12345",
            alias: "12345",
            recordingId: "start-1",
            masterPlaylistUrl: "https://example.test/master.m3u8",
        }]]),
        terminalTargetIds: new Set(),
    });
    assert.equal(result.resumePaths.get("12345"), value.recordingPath);
    await stat(value.recordingPath);
});
