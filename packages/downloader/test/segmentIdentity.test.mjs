import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
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

test("resume skips overlap using the persisted HLS media sequence tail", async (t) => {
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
});

async function liveCapture(t, recordingId) {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-platform-restart-"));
    t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
    const disk = new DiskSession("alias", { update() {} }, async () => root);
    const manager = new PlaylistManager(disk, recordingId);
    const poll = async (mediaSequence, count, extra = []) => {
        const segments = await manager.identifyNewSegments([
            "#EXTM3U",
            "#EXT-X-TARGETDURATION:2",
            `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`,
            ...extra,
            ...Array.from({ length: count }, (_, offset) => ["#EXTINF:2,", `seg-${mediaSequence + offset}.ts`]).flat(),
        ].join("\n"), (line) => `https://example.test/${line}`);
        await disk.materialize();
        for (const segment of segments) await manager.appendSegmentToPlaylist(segment);
        return segments.map((segment) => segment.providerSequence);
    };
    const playlist = () => readFile(path.join(root, "playlist.m3u8"), "utf8");
    return { root, disk, manager, poll, playlist };
}

test("an FC2-like media-sequence restart 1112 -> 1 is new media after one discontinuity", async (t) => {
    const capture = await liveCapture(t, "fc2-start");
    assert.deepEqual(await capture.poll(1108, 5), [1108, 1109, 1110, 1111, 1112]);
    assert.deepEqual(await capture.poll(1, 4), [1, 2, 3, 4]);
    // The new run is the baseline now: its overlap is deduplicated normally.
    assert.deepEqual(await capture.poll(3, 4), [5, 6]);
    const content = await capture.playlist();
    assert.equal((content.match(/#EXT-X-DISCONTINUITY/g) ?? []).length, 1);
    assert.match(content, /4_fc2-start_1112\.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:2,\n5_fc2-start_1\.ts\n/);
    assert.deepEqual(content.split("\n").filter((line) => line.endsWith(".ts")).map((line) => line.split("_").at(-1)),
        ["1108.ts", "1109.ts", "1110.ts", "1111.ts", "1112.ts", "1.ts", "2.ts", "3.ts", "4.ts", "5.ts", "6.ts"]);
});

test("an SC-like edge renumbering 693 -> 26 is accepted instead of skipped until 694", async (t) => {
    const capture = await liveCapture(t, "2026-09-21T134247Z");
    assert.deepEqual(await capture.poll(689, 5), [689, 690, 691, 692, 693]);
    assert.deepEqual(await capture.poll(22, 5), [22, 23, 24, 25, 26]);
    assert.deepEqual(await capture.poll(25, 5), [27, 28, 29]);
    assert.match(await capture.playlist(), /_693\.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:2,\n\d+_2026-09-21T134247Z_22\.ts\n/);
});

test("a stale window slightly below the baseline is still deduplicated, not a restart", async (t) => {
    const capture = await liveCapture(t, "stream");
    assert.deepEqual(await capture.poll(100, 6), [100, 101, 102, 103, 104, 105]);
    // A lagging CDN copy re-lists already-saved media only.
    assert.deepEqual(await capture.poll(96, 6), []);
    assert.deepEqual(await capture.poll(85, 6), []);
    assert.deepEqual(await capture.poll(103, 6), [106, 107, 108]);
    assert.doesNotMatch(await capture.playlist(), /#EXT-X-DISCONTINUITY/);
});

test("resume after a committed restart takes the playlist tail, not the maximum", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-platform-resume-restart-"));
    t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
    const recordingId = "fc2-start";
    const entries = [[0, 1110], [1, 1111], [2, 1112], [3, 1], [4, 2], [5, 3]];
    await writeFile(path.join(root, "playlist.m3u8"), [
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:2",
        "#EXT-X-MEDIA-SEQUENCE:1110",
        ...entries.flatMap(([local, sequence]) => [
            ...(sequence === 1 ? ["#EXT-X-DISCONTINUITY"] : []),
            "#EXTINF:2,",
            formatSegmentName(local, recordingId, sequence),
        ]),
        "",
    ].join("\n"));
    const disk = new DiskSession("alias", { update() {} }, async () => root, root);
    const manager = new PlaylistManager(disk, recordingId);
    await manager.initializeFromExistingPlaylist();
    const next = await manager.identifyNewSegments([
        "#EXTM3U",
        "#EXT-X-MEDIA-SEQUENCE:2",
        ...[2, 3, 4, 5].flatMap((sequence) => ["#EXTINF:2,", `${sequence}.ts`]),
    ].join("\n"), (line) => `https://example.test/${line}`);
    assert.deepEqual(next.map((segment) => segment.providerSequence), [4, 5]);
    assert.equal(next[0].localName, formatSegmentName(6, recordingId, 4));
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

test("resume drops a torn playlist tail, re-appends the written media, and never reuses its local number", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-platform-torn-playlist-"));
    t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
    const recordingId = "stream";
    const referenced = formatSegmentName(0, recordingId, 10);
    const unreferenced = formatSegmentName(1, recordingId, 11);
    await writeFile(path.join(root, referenced), "referenced");
    await writeFile(path.join(root, unreferenced), "power-loss-orphan");
    await writeFile(path.join(root, "playlist.m3u8"), [
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:2",
        "#EXT-X-MEDIA-SEQUENCE:10",
        "#EXTINF:1.5,",
        referenced,
        "#EXTINF:1,",
        "1_stream_",
    ].join("\n"));
    const disk = new DiskSession("alias", { update() {} }, async () => root, root);
    const manager = new PlaylistManager(disk, recordingId);
    await manager.initializeFromExistingPlaylist();
    assert.equal(manager.nextSegmentNumber, 2);
    const content = await readFile(path.join(root, "playlist.m3u8"), "utf8");
    assert.doesNotMatch(content, /1_stream_\n|#EXTINF:1,\n#EXTINF/);
    // The written media follows the tail again, with a provisional duration.
    assert.match(content, /0_stream_10\.ts\n#EXTINF:1\.500,\n1_stream_11\.ts\n$/);

    const next = await manager.identifyNewSegments([
        "#EXTM3U",
        "#EXT-X-MEDIA-SEQUENCE:11",
        "#EXTINF:1,",
        "11.ts",
        "#EXTINF:1,",
        "12.ts",
    ].join("\n"), (line) => `https://example.test/${line}`);
    assert.deepEqual(next.map((segment) => segment.providerSequence), [12]);
    assert.equal(next[0].localName, formatSegmentName(2, recordingId, 12));
});

test("resume keeps unreferenced media that is empty, unreadable, or older than the tail on disk without re-appending", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-platform-orphans-"));
    t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
    const recordingId = "stream";
    const files = {
        [formatSegmentName(0, recordingId, 9)]: "kept-older-rejected",
        [formatSegmentName(1, recordingId, 10)]: "tail",
        [formatSegmentName(2, recordingId, 11)]: "",
        [formatSegmentName(3, recordingId, 12)]: "unreadable",
        [formatSegmentName(4, recordingId, 13)]: "valid",
    };
    for (const [name, data] of Object.entries(files)) await writeFile(path.join(root, name), data);
    await writeFile(path.join(root, "playlist.m3u8"), [
        "#EXTM3U", "#EXT-X-TARGETDURATION:2", "#EXT-X-MEDIA-SEQUENCE:10",
        "#EXTINF:2,", formatSegmentName(1, recordingId, 10), "",
    ].join("\n"));
    const disk = new DiskSession("alias", { update() {} }, async () => root, root);
    const manager = new PlaylistManager(disk, recordingId);
    await manager.initializeFromExistingPlaylist(async (filePath) =>
        path.basename(filePath) === formatSegmentName(3, recordingId, 12)
            ? { valid: false }
            : { valid: true, duration: 1.25 });
    const content = await readFile(path.join(root, "playlist.m3u8"), "utf8");
    assert.deepEqual(content.split("\n").filter((line) => line.endsWith(".ts")),
        [formatSegmentName(1, recordingId, 10), formatSegmentName(4, recordingId, 13)]);
    // Sequence 13 does not follow 10 directly: the gap is a boundary.
    assert.match(content, /#EXT-X-DISCONTINUITY\n#EXTINF:1\.250,\n4_stream_13\.ts\n$/);
    assert.deepEqual((await readdir(root)).sort(), [...Object.keys(files), "playlist.m3u8"].sort());
    assert.equal(manager.nextSegmentNumber, 5);
});

test("fMP4 media written after a buffered map change is re-appended under its own map", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-platform-fmp4-orphan-"));
    t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
    const recordingId = "sc-epoch";
    for (const name of ["init.mp4", "init_2.mp4", formatSegmentName(0, recordingId, 40),
        formatSegmentName(1, recordingId, 41), formatSegmentName(2, recordingId, 42)]) {
        await writeFile(path.join(root, name), name);
    }
    await writeFile(path.join(root, "playlist.m3u8"), [
        "#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:2", "#EXT-X-MEDIA-SEQUENCE:40",
        '#EXT-X-MAP:URI="init.mp4"',
        "#EXTINF:2,", formatSegmentName(0, recordingId, 40),
        "#EXTINF:2,", formatSegmentName(1, recordingId, 41), "",
    ].join("\n"));
    const disk = new DiskSession("alias", { update() {} }, async () => root, root);
    const manager = new PlaylistManager(disk, recordingId);
    await manager.initializeFromExistingPlaylist(async () => ({ valid: true, duration: 2 }));
    assert.match(await readFile(path.join(root, "playlist.m3u8"), "utf8"),
        /1_sc-epoch_41\.ts\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="init_2\.mp4"\n#EXTINF:2\.000,\n2_sc-epoch_42\.ts\n$/);
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
