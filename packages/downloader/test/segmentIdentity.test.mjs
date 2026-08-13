import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DiskSession } from "../dist/services/download/diskSession.js";
import { PlaylistManager } from "../dist/services/download/playlistManager.js";
import { InitTracker } from "../dist/services/download/initTracker.js";
import {
    formatSegmentName,
    normalizeRecordingId,
    parseCompoundSegmentName,
} from "../dist/services/download/segmentIdentity.js";

test("compound names round-trip recording IDs containing separators", () => {
    const name = formatSegmentName(17, "broadcast_value-with.parts", 0);
    assert.deepEqual(parseCompoundSegmentName(name), {
        localNumber: 17,
        recordingId: "broadcast_value-with.parts",
        providerSequence: 0,
    });
});

test("Stripchat UTC identities stay visible without URI escape sequences", () => {
    const raw = "2026-08-12T09:08:47Z";
    const normalized = "2026-08-12T090847Z";
    const name = formatSegmentName(0, raw, 765);
    assert.equal(normalizeRecordingId(raw), normalized);
    assert.equal(name, `0_${normalized}_765.ts`);
    assert.equal(decodeURIComponent(new URL(name, "https://example.test/hls/sc/video/").pathname.split("/").at(-1)), name);
    assert.deepEqual(parseCompoundSegmentName(name), {
        localNumber: 0,
        recordingId: normalized,
        providerSequence: 765,
    });
});

test("the short-lived percent-encoded format remains readable for migration", () => {
    assert.deepEqual(parseCompoundSegmentName("0_2026-08-12T09%3A08%3A47Z_765.ts"), {
        localNumber: 0,
        recordingId: "2026-08-12T090847Z",
        providerSequence: 765,
    });
});

test("resume skips overlap using the highest persisted HLS media sequence", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-platform-playlist-"));
    t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
    const recordingId = "broadcast-abc";
    const names = [
        formatSegmentName(5, recordingId, 66),
        formatSegmentName(6, recordingId, 67),
        formatSegmentName(7, recordingId, 68),
    ];
    await writeFile(path.join(root, "playlist.m3u8"), [
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:2",
        "#EXT-X-MEDIA-SEQUENCE:66",
        ...names.flatMap((name) => ["#EXTINF:1,", name]),
        "",
    ].join("\n"));
    const handle = { update() {} };
    const disk = new DiskSession("alias", handle, async () => root, root);
    const manager = new PlaylistManager(disk, recordingId);
    await manager.initializeFromExistingPlaylist();

    const overlap = await manager.identifyNewSegments([
        "#EXTM3U",
        "#EXT-X-MEDIA-SEQUENCE:67",
        "#EXTINF:1,",
        "67.ts",
        "#EXTINF:1,",
        "68.ts",
        "#EXTINF:1,",
        "69.ts",
    ].join("\n"), (line) => `https://example.test/${line}`);
    assert.deepEqual(overlap.map((segment) => segment.providerSequence), [69]);
    assert.equal(overlap[0].localName, formatSegmentName(8, recordingId, 69));

    const regressedWindow = await manager.identifyNewSegments([
        "#EXTM3U",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-DISCONTINUITY",
        "#EXTINF:1,",
        "0.ts",
    ].join("\n"), (line) => `https://example.test/reset/${line}`);
    assert.deepEqual(regressedWindow, []);
});

test("an HLS window overlapping by more than ten segments downloads only its new edge", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-platform-long-overlap-"));
    t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
    const recordingId = "fc2-start";
    const disk = new DiskSession("alias", { update() {} }, async () => root);
    const manager = new PlaylistManager(disk, recordingId);

    const firstWindow = await manager.identifyNewSegments([
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:2",
        "#EXT-X-MEDIA-SEQUENCE:2",
        ...Array.from({ length: 17 }, (_, offset) => ["#EXTINF:1,", `${offset + 2}.ts`]).flat(),
    ].join("\n"), (line) => `https://example.test/${line}`);
    for (const segment of firstWindow) {
        await disk.materialize();
        await manager.appendSegmentToPlaylist(segment);
    }

    const nextWindow = await manager.identifyNewSegments([
        "#EXTM3U",
        "#EXT-X-MEDIA-SEQUENCE:8",
        ...Array.from({ length: 12 }, (_, offset) => ["#EXTINF:1,", `${offset + 8}.ts`]).flat(),
    ].join("\n"), (line) => `https://example.test/${line}`);
    assert.deepEqual(nextWindow.map((segment) => segment.providerSequence), [19]);
    assert.equal(nextWindow[0].localName, formatSegmentName(17, recordingId, 19));
});

test("a reset FC2 URI remains new when its HLS media sequence is monotonic", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-platform-uri-reset-"));
    t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
    const recordingId = "fc2-start";
    const disk = new DiskSession("alias", { update() {} }, async () => root);
    const manager = new PlaylistManager(disk, recordingId);

    const segments = await manager.identifyNewSegments([
        "#EXTM3U",
        "#EXT-X-MEDIA-SEQUENCE:2554",
        "#EXTINF:1,",
        "2554.ts",
        "#EXTINF:1,",
        "2555.ts",
        "#EXT-X-DISCONTINUITY",
        "#EXTINF:1,",
        "0.ts",
        "#EXTINF:1,",
        "1.ts",
    ].join("\n"), (line) => `https://example.test/${line}`);

    assert.deepEqual(segments.map((segment) => segment.providerSequence), [2554, 2555, 2556, 2557]);
    assert.equal(segments[2].remoteUrl, "https://example.test/0.ts");
    assert.equal(segments[2].localName, formatSegmentName(2, recordingId, 2556));
});

test("resume drops a torn playlist tail and never reuses an unreferenced local number", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-platform-torn-playlist-"));
    t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
    const recordingId = "stream";
    const referenced = formatSegmentName(0, recordingId, 10);
    const unreferenced = formatSegmentName(1, recordingId, 999);
    await writeFile(path.join(root, referenced), "referenced");
    await writeFile(path.join(root, unreferenced), "power-loss-orphan");
    await writeFile(path.join(root, "playlist.m3u8"), [
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:2",
        "#EXT-X-MEDIA-SEQUENCE:10",
        "#EXTINF:1,",
        referenced,
        "#EXTINF:1,",
        "1_stream_",
    ].join("\n"));
    const disk = new DiskSession("alias", { update() {} }, async () => root, root);
    const manager = new PlaylistManager(disk, recordingId);
    await manager.initializeFromExistingPlaylist();
    assert.equal(manager.nextSegmentNumber, 2);
    assert.doesNotMatch(await readFile(path.join(root, "playlist.m3u8"), "utf8"), /1_stream_|#EXTINF:1,\n#EXTINF/);

    const next = await manager.identifyNewSegments([
        "#EXTM3U",
        "#EXT-X-MEDIA-SEQUENCE:11",
        "#EXTINF:1,",
        "11.ts",
    ].join("\n"), (line) => `https://example.test/${line}`);
    assert.equal(next[0].localName, formatSegmentName(2, recordingId, 11));
});

test("resume after first media write advances beyond the unreferenced local number", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-platform-first-write-"));
    t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
    const recordingId = "first-write";
    await writeFile(path.join(root, formatSegmentName(0, recordingId, 50)), "power-loss-orphan");
    const disk = new DiskSession("alias", { update() {} }, async () => root, root);
    const manager = new PlaylistManager(disk, recordingId);
    await manager.initializeFromExistingPlaylist();
    assert.equal(manager.nextSegmentNumber, 1);

    const [next] = await manager.identifyNewSegments([
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:2",
        "#EXT-X-MEDIA-SEQUENCE:50",
        "#EXTINF:1,",
        "50.ts",
    ].join("\n"), (line) => `https://example.test/${line}`);
    assert.equal(next.localName, formatSegmentName(1, recordingId, 50));
});

test("fMP4 resume publishes one discontinuity and a fresh non-overwriting map", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-platform-fmp4-resume-"));
    t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
    const recordingId = "public-epoch";
    const first = formatSegmentName(0, recordingId, 40);
    await writeFile(path.join(root, first), "fragment");
    await writeFile(path.join(root, "init.mp4"), "old-init");
    await writeFile(path.join(root, "playlist.m3u8"), [
        "#EXTM3U",
        "#EXT-X-VERSION:7",
        "#EXT-X-TARGETDURATION:2",
        "#EXT-X-MEDIA-SEQUENCE:40",
        '#EXT-X-MAP:URI="init.mp4"',
        "#EXTINF:1,",
        first,
        "",
    ].join("\n"));
    const disk = new DiskSession("alias", { update() {} }, async () => root, root);
    const manager = new PlaylistManager(disk, recordingId);
    await manager.initializeFromExistingPlaylist();
    const initTracker = new InitTracker(disk);
    initTracker.markResumeBoundary(manager.nextSegmentNumber);
    const init = await initTracker.commitInit("new-map.mp4", async () => ({ data: Buffer.from("new-init") }), manager.nextSegmentNumber);
    assert.equal(init.fileName, "init_1.mp4");
    manager.bufferQualityChange(init.fileName);
    const [segment] = await manager.identifyNewSegments([
        "#EXTM3U",
        "#EXT-X-MEDIA-SEQUENCE:41",
        "#EXT-X-MAP:URI=\"new-map.mp4\"",
        "#EXTINF:1,",
        "41.mp4",
    ].join("\n"), (line) => `https://example.test/${line}`);
    await manager.appendSegmentToPlaylist(segment);
    const content = await readFile(path.join(root, "playlist.m3u8"), "utf8");
    assert.equal((content.match(/#EXT-X-DISCONTINUITY/g) ?? []).length, 1);
    assert.match(content, /#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="init_1\.mp4"\n#EXTINF:1,\n1_public-epoch_41\.ts/);
});
