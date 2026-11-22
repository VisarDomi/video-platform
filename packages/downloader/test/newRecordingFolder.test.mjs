import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The status file and the desktop Trash live under $HOME; keep both out of the real one.
const home = await mkdtemp(path.join(os.tmpdir(), "new-recording-folder-"));
process.env.HOME = home;
process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
process.env.VIDEO_DOWNLOADS_ROOT = path.join(home, "downloads");
// The status file is written 200 ms after the last change; let that write finish first.
test.after(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await rm(home, { recursive: true, force: true });
});
const { DownloadsManager } = await import("../dist/services/state/downloadsManager.js");
const { ActiveRecordingReconciler } = await import("../dist/services/common/activeRecordingReconciler.js");
const { DiskSession } = await import("../dist/services/download/diskSession.js");
const { setupDownloadDir } = await import("../dist/services/core/downloadUtils.js");

const offline = () => ({ observedAt: Date.now(), live: new Map(), terminalTargetIds: new Set() });

// The folder scan moves an empty active folder that no session owns to the Trash. A new
// recording's folder is empty until its first segment, and creating it durably syncs every
// ancestor directory, so a scan could run after the folder appeared and before the session
// had named it: the session's first writes then failed and the stream was lost until a new
// session started (20 s to 2 min, three times in November 2026).
test("a folder scan during a new recording's folder creation leaves the folder to its session", async () => {
    const manager = await DownloadsManager.create();
    const handle = manager.add("https://cdn.example.test/s1/master.m3u8", { streamerId: "s1", alias: "s1", recordingId: "r1" }, "site-a");
    assert.ok(handle);
    const reconciler = new ActiveRecordingReconciler("site-a", manager, (alias) => (alias === "s1" ? "s1" : null));

    let scannedWhileCreating = false;
    const disk = new DiskSession("s1", handle, async (claim) => {
        const dirPath = await setupDownloadDir("site-a", "s1", new Date(2026, 10, 21, 11, 54, 14), claim);
        // The folder exists now and the creation has not returned: the scan runs here.
        await reconciler.reconcile(offline());
        scannedWhileCreating = true;
        return dirPath;
    });

    assert.equal(await disk.materialize(), true);
    assert.equal(scannedWhileCreating, true);
    const expected = path.join(process.env.VIDEO_DOWNLOADS_ROOT, "site-a", "downloaded", ".active", "2026-11-21 115414 s1");
    assert.equal(disk.dirPath, expected);
    assert.equal((await stat(expected)).isDirectory(), true, "the scan must not move the new folder away");
    assert.equal(await disk.present(), true);
    assert.equal(manager.getActiveSegmentPaths().has(expected), true);
});

test("a folder that could not be created is no longer claimed by its session", async () => {
    const manager = await DownloadsManager.create();
    const handle = manager.add("https://cdn.example.test/s2/master.m3u8", { streamerId: "s2", alias: "s2", recordingId: "r2" }, "site-a");
    assert.ok(handle);
    const disk = new DiskSession("s2", handle, async (claim) => {
        claim(path.join(home, "unwritable", "2026-11-21 115414 s2"));
        return null;
    });

    assert.equal(await disk.materialize(), false);
    assert.equal(disk.materialized, false);
    assert.equal(handle.state.segmentsDirPath, null);
    assert.equal(manager.getActiveSegmentPaths().size, 0);
});
