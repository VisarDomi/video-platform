import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    inspectFinalizedRecording,
    inspectRecording,
    scanFinalizedRoots,
    scanRoots,
} from "../dist/discovery/inspectRecording.js";

async function fixture(t, options = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-pipeline-discovery-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sourcePath = path.join(root, "recording");
    await mkdir(sourcePath);
    const endList = options.endList === false ? "" : "#EXT-X-ENDLIST\n";
    await writeFile(path.join(sourcePath, "playlist.m3u8"), [
        "#EXTM3U",
        "#EXTINF:1.5,",
        "00001.ts",
        "#EXTINF:2.5,",
        "00002.ts",
        endList,
    ].join("\n"));
    await writeFile(path.join(sourcePath, "00001.ts"), "one");
    await writeFile(path.join(sourcePath, "00002.ts"), "two");
    if (options.integrity !== false) {
        await writeFile(path.join(sourcePath, ".media-integrity.json"), JSON.stringify({
            version: 2,
            status: options.integrityStatus ?? "ready",
            segmentCount: options.segmentCount ?? 2,
            invalidSegments: options.invalidSegments ?? [],
        }));
    }
    return { root, sourcePath };
}

test("eligible discovery requires ENDLIST and matching ready integrity evidence", async (t) => {
    const { sourcePath } = await fixture(t);
    const result = await inspectRecording(sourcePath, "tango", "downloader");
    assert.equal(result.status, "eligible");
    assert.equal(result.recording.durationSeconds, 4);
    assert.match(result.recording.sourceFingerprint, /^[a-f0-9]{64}$/);
});

test("failed, missing, and mismatched integrity evidence fail closed", async (t) => {
    const failed = await fixture(t, { integrityStatus: "failed", invalidSegments: [{ name: "00002.ts" }] });
    assert.equal((await inspectRecording(failed.sourcePath, "tango", "downloader")).reason, "integrity_failed");

    const missing = await fixture(t, { integrity: false });
    assert.equal((await inspectRecording(missing.sourcePath, "tango", "downloader")).reason, "integrity_missing");

    const mismatched = await fixture(t, { segmentCount: 1 });
    assert.equal((await inspectRecording(mismatched.sourcePath, "tango", "downloader")).reason, "integrity_evidence_mismatch");
});

test("live recordings are excluded and root scans ignore nondirectories", async (t) => {
    const { root, sourcePath } = await fixture(t, { endList: false });
    await writeFile(path.join(root, "ordinary-file"), "ignored");
    assert.equal((await inspectRecording(sourcePath, "tango", "downloader")).reason, "live_or_unfinalized");
    const results = await scanRoots([{ provider: "tango", sourceKind: "downloader", path: root }]);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "excluded");
});

test("finalized discovery can enroll missing integrity for the later integrity stage", async (t) => {
    const { sourcePath } = await fixture(t, { integrity: false });
    const result = await inspectFinalizedRecording(sourcePath, "tango", "downloader");
    assert.equal(result.status, "finalized");
});

test("hidden active roots are ignored and finalized edited recordings supersede downloader copies", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-pipeline-precedence-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const downloader = path.join(root, "downloader");
    const edited = path.join(root, "edited");
    await mkdir(path.join(downloader, "same"), { recursive: true });
    await mkdir(path.join(edited, "same"), { recursive: true });
    for (const sourcePath of [path.join(downloader, "same"), path.join(edited, "same")]) {
        await writeFile(path.join(sourcePath, "playlist.m3u8"), "#EXTM3U\n#EXTINF:1,\n00001.ts\n#EXT-X-ENDLIST\n");
        await writeFile(path.join(sourcePath, "00001.ts"), "media");
    }
    const roots = [
        { provider: "tango", sourceKind: "downloader", path: downloader },
        { provider: "tango", sourceKind: "edited", path: edited },
    ];
    const preferred = await scanFinalizedRoots(roots);
    assert.equal(preferred.length, 1);
    assert.equal(preferred[0].recording.sourceKind, "edited");
    await mkdir(path.join(downloader, ".active", "live"), { recursive: true });
    await writeFile(path.join(downloader, ".active", "live", "playlist.m3u8"), "#EXTM3U\n");
    const withActive = await scanFinalizedRoots(roots);
    assert.equal(withActive.length, 1);
    assert.equal(withActive[0].recording.sourceKind, "edited");
});
