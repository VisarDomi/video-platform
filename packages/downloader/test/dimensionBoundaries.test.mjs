import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DiskSession } from "../dist/services/download/diskSession.js";
import { PlaylistManager } from "../dist/services/download/playlistManager.js";
import { InitTracker } from "../dist/services/download/initTracker.js";
import { ApiClient } from "../dist/services/tango/api/apiClient.js";
import { Fc2Client } from "../dist/services/fc2/api/fc2Client.js";
import { fixturePart } from "../../pipeline/test/helpers/mediaFixture.mjs";

const dims = (width, height, sampleAspectRatio = "1:1") => ({ width, height, sampleAspectRatio });
async function setup(t, fmp4 = false) {
    const root = await mkdtemp(path.join(os.tmpdir(), "capture-dimensions-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const disk = new DiskSession("test", { update() {} }, async () => root);
    const manager = new PlaylistManager(disk, "test");
    const segments = await manager.identifyNewSegments([
        "#EXTM3U", "#EXT-X-TARGETDURATION:1", "#EXT-X-MEDIA-SEQUENCE:0",
        ...(fmp4 ? ['#EXT-X-MAP:URI="720-init"'] : []),
        ...Array.from({ length: 8 }, (_, i) => ["#EXTINF:1,", `${i}.ts`]).flat(),
    ].join("\n"), (line) => `https://example.test/${line}`);
    await disk.materialize();
    return { root, disk, manager, segments };
}
async function boundaries(root) {
    const lines = (await readFile(path.join(root, "playlist.m3u8"), "utf8")).trim().split("\n");
    let tags = 0;
    return lines.flatMap((line) => {
        if (line === "#EXT-X-DISCONTINUITY") tags++;
        if (line.startsWith("#")) return [];
        const count = tags;
        tags = 0;
        return [{ name: line, tags: count }];
    });
}

test("TS dimension and SAR changes get one boundary; stable dimensions get none", async (t) => {
    const { root, manager, segments } = await setup(t);
    const dimensions = [dims(720, 1280), dims(720, 1280), dims(1080, 1920),
        dims(1920, 1080), dims(1920, 1080, "4:3"), dims(1920, 1080, "4:3")];
    for (const [i, dimensionsForSegment] of dimensions.entries()) {
        segments[i].dimensions = dimensionsForSegment;
        if (i === 3) segments[i].metadata.unshift("#EXT-X-DISCONTINUITY");
        await manager.appendSegmentToPlaylist(segments[i]);
    }
    assert.deepEqual((await boundaries(root)).map((s) => s.tags), [0, 0, 1, 1, 1, 0]);
});

test("rejected segments do not alter geometry baseline; sequence gap supplies one boundary", async (t) => {
    const { root, manager, segments } = await setup(t);
    segments[0].dimensions = dims(720, 1280);
    await manager.appendSegmentToPlaylist(segments[0]);
    manager.addIgnoredSegment(segments[1].providerSequence);
    segments[2].dimensions = dims(1080, 1920);
    await manager.appendSegmentToPlaylist(segments[2]);
    assert.deepEqual((await boundaries(root)).map((s) => s.tags), [0, 1]);
});

test("unknown FC2 dimensions retain the segment with boundaries before and after", async (t) => {
    const { root, manager, segments } = await setup(t);
    for (const [i, dimension] of [dims(1280, 720), null, dims(1280, 720)].entries()) {
        segments[i].dimensions = dimension;
        await manager.appendSegmentToPlaylist(segments[i]);
    }
    assert.deepEqual((await boundaries(root)).map((s) => s.tags), [0, 1, 1]);
});

test("resumed TS capture marks the first new segment without probing the existing catalog", async (t) => {
    const { root, disk, manager, segments } = await setup(t);
    segments[0].dimensions = dims(1280, 720);
    await manager.appendSegmentToPlaylist(segments[0]);
    const resumed = new PlaylistManager(disk, "test");
    await resumed.initializeFromExistingPlaylist();
    segments[1].dimensions = dims(1920, 1080);
    await resumed.appendSegmentToPlaylist(segments[1]);
    assert.deepEqual((await boundaries(root)).map((s) => s.tags), [0, 1]);
});

test("SC init-map quality changes still retain fragments and publish one map boundary", async (t) => {
    const { root, disk, manager, segments } = await setup(t, true);
    const tracker = new InitTracker(disk);
    const first = await tracker.commitInit("720-init", async () => ({ data: Buffer.from("720-init") }), 0);
    assert.equal(first.isQualityChange, false);
    await manager.appendSegmentToPlaylist(segments[0]);
    const next = await tracker.commitInit("1080-init", async () => ({ data: Buffer.from("1080-init") }), 1);
    assert.equal(next.isQualityChange, true);
    manager.bufferQualityChange(next.fileName);
    segments[1].metadata.unshift("#EXT-X-DISCONTINUITY");
    await manager.appendSegmentToPlaylist(segments[1]);
    assert.deepEqual((await boundaries(root)).map((s) => s.tags), [0, 1]);
    assert.match(await readFile(path.join(root, "playlist.m3u8"), "utf8"),
        /#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="init_1.mp4"\n#EXTINF/);
    assert.match(await readFile(path.join(root, "playlist.m3u8"), "utf8"), /#EXT-X-MAP:URI="init.mp4"/);
});

test("real new-segment probes keep every FC2 resolution but preserve Tango's 360p guard", async (t) => {
    const { root } = await setup(t);
    // These methods need no account/session state; avoid starting FC2's timer.
    for (const size of ["360x640", "640x360", "720x1280", "1280x720", "1920x1080"]) {
        const part = await fixturePart(root, size, { size, frames: 2 });
        const fc2 = await Fc2Client.prototype.validateSegment.call({}, part.input);
        const tango = await ApiClient.prototype.validateSegment.call({}, part.input);
        const [width, height] = size.split("x").map(Number);
        assert.deepEqual(fc2, { valid: true, dimensions: dims(width, height) });
        assert.equal(tango.valid, !["360x640", "640x360"].includes(size));
        if (tango.valid) assert.deepEqual(tango.dimensions, fc2.dimensions);
    }
    const unknown = path.join(root, "unknown.ts");
    await writeFile(unknown, "not media");
    assert.deepEqual(await Fc2Client.prototype.validateSegment.call({}, unknown), { valid: true, dimensions: null });
});
