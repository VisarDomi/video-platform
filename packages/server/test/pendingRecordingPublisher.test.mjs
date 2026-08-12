import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { FinalizationCheckpointStore } from "../dist/services/hls/finalizationCheckpointStore.js";
import { processFinalizedRecording } from "../dist/services/hls/finalizedRecordingProcessor.js";
import { publishPendingRecording } from "../dist/services/hls/pendingRecordingPublisher.js";

const execFileAsync = promisify(execFile);

test("only the server publisher can make a pending recording visible as finalized", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pending-publication-"));
    t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
    const pendingRoot = path.join(root, ".pending");
    const pendingPath = path.join(pendingRoot, "recording");
    await mkdir(pendingPath, { recursive: true });
    await writeFile(path.join(pendingPath, "playlist.m3u8"), "#EXTM3U\n#EXT-X-ENDLIST\n");

    await assert.rejects(stat(path.join(root, "recording")), { code: "ENOENT" });
    const finalizedPath = await publishPendingRecording(pendingPath);
    assert.equal(finalizedPath, path.join(root, "recording"));
    assert.equal((await stat(finalizedPath)).isDirectory(), true);
    await assert.rejects(stat(pendingPath), { code: "ENOENT" });
});

test("publisher rejects paths that did not arrive through a pending root", async () => {
    await assert.rejects(
        publishPendingRecording("/tmp/not-pending/recording"),
        /outside \.pending/,
    );
});

test("a real pending HLS recording is decoded before publication without a sidecar", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pending-validation-"));
    const checkpointStore = new FinalizationCheckpointStore(path.join(root, "finalization.sqlite"));
    t.after(async () => {
        checkpointStore.close();
        await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
    });
    const pendingPath = path.join(root, "downloader", ".pending", "recording");
    await mkdir(pendingPath, { recursive: true });
    const segmentPath = path.join(pendingPath, "0_stream_0.ts");
    await execFileAsync("ffmpeg", [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10",
        "-t", "0.3", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-f", "mpegts", segmentPath,
    ]);
    await writeFile(path.join(pendingPath, "playlist.m3u8"), [
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:1",
        "#EXTINF:0.3,",
        "0_stream_0.ts",
        "#EXT-X-ENDLIST",
        "",
    ].join("\n"));

    const result = await processFinalizedRecording(pendingPath, { checkpointStore });
    assert.notEqual(result.kind, "not-finalized");
    assert.equal(result.report.status, "ready");
    const finalizedPath = await publishPendingRecording(pendingPath);
    checkpointStore.clear(pendingPath);
    assert.equal((await stat(finalizedPath)).isDirectory(), true);
    await assert.rejects(stat(path.join(finalizedPath, ".media-integrity.json")), { code: "ENOENT" });
});
