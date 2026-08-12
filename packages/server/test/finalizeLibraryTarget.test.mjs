import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveManagedRecordingTarget } from "../dist/commands/finalizeLibraryTarget.js";

async function fixture(t) {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "finalize-library-target-"));
    t.after(() => import("node:fs/promises").then(({ rm }) => rm(temporaryRoot, { recursive: true, force: true })));
    const managedRoot = path.join(temporaryRoot, "downloader");
    await mkdir(managedRoot);
    return {
        temporaryRoot,
        managedRoot,
        roots: [{ provider: "tango", scope: "downloads", rootPath: managedRoot }],
    };
}

test("single-recording mode resolves exactly one immediate managed recording", async (t) => {
    const { managedRoot, roots } = await fixture(t);
    const recording = path.join(managedRoot, "recording");
    await mkdir(recording);
    await writeFile(path.join(recording, "playlist.m3u8"), "#EXTM3U\n#EXT-X-ENDLIST\n");

    assert.deepEqual(await resolveManagedRecordingTarget(recording, roots), {
        provider: "tango",
        scope: "downloads",
        recordingPath: recording,
    });
});

test("single-recording mode rejects nested, hidden, and symlinked directories", async (t) => {
    const { temporaryRoot, managedRoot, roots } = await fixture(t);
    const nestedParent = path.join(managedRoot, "parent");
    const nested = path.join(nestedParent, "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "playlist.m3u8"), "#EXTM3U\n");
    await assert.rejects(resolveManagedRecordingTarget(nested, roots), /immediate child/);

    const hidden = path.join(managedRoot, ".pending");
    await mkdir(hidden);
    await writeFile(path.join(hidden, "playlist.m3u8"), "#EXTM3U\n");
    await assert.rejects(resolveManagedRecordingTarget(hidden, roots), /visible finalized/);

    const external = path.join(temporaryRoot, "external");
    const linked = path.join(managedRoot, "linked");
    await mkdir(external);
    await writeFile(path.join(external, "playlist.m3u8"), "#EXTM3U\n");
    await symlink(external, linked, "dir");
    await assert.rejects(resolveManagedRecordingTarget(linked, roots), /not a symlink/);
});
