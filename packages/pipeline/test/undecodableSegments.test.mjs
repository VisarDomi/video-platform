import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    analyzeRecordingResolution,
    chooseRecordingResolutionPolicy,
    deriveResolutionPlaylist,
} from "../dist/stages/resolutionPolicy.js";
import { createDefaultStages } from "../dist/stages/defaultStages.js";
import { validateArtifact } from "../dist/stages/validateArtifact.js";
import { fixturePart, undecodableStub, assemble, frameIds, audioPackets, videoSliceHashes } from "./helpers/mediaFixture.mjs";

async function temporary(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-undecodable-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}

async function concatenated(read, parts) {
    return (await Promise.all(parts.map((part) => read(part.input)))).flat();
}

// Live stubs are short; a 0.1 s EXTINF keeps the fixture inside the 5% bound.
// Its content is never used once dropped, so the shorter tag is harmless.
const STUB_SECONDS = 0.1;
const durations = (parts) => parts.map((part) => part.stub ? STUB_SECONDS : part.frames / 10);
const dropNote = /dropped 1 segment\(s\) with no independently decodable video keyframe \(part-1\.ts 0\.100000s; total 0\.100000s\)/;

async function parts(root, size) {
    // Unique luma IDs across both decodable parts (30..118 and 130..218).
    const a = await fixturePart(root, "a", { size, frames: 12 });
    const stub = { ...await undecodableStub(root, "stub", { size }), stub: true };
    const b = await fixturePart(root, "b", { size, frames: 12, offset: 100 });
    return { a, stub, b };
}

test("a TS stub without a decodable keyframe is dropped from classification with durable evidence", async (t) => {
    const root = await temporary(t);
    const { a, stub, b } = await parts(root, "640x360");
    const playlist = await assemble(root, [a, stub, b], durations([a, stub, b]));
    const analysis = await analyzeRecordingResolution(playlist);
    assert.deepEqual(analysis.segments.map((segment) => segment.index), [0, 2]);
    assert.deepEqual(analysis.undecodableSegments, [{ index: 1, name: "part-1.ts", durationSeconds: STUB_SECONDS }]);
    assert.equal(analysis.resolutionSummary, "640x360:2");
    const policy = chooseRecordingResolutionPolicy(analysis);
    assert.equal(policy.disposition, "convert1080");
    assert.match(policy.reason, dropNote);
    assert.match(policy.reason, /with no decodable segments dropped/);
    // An explicit selection can never bring the stub back.
    assert(!deriveResolutionPlaylist(analysis, new Set([0, 1, 2])).includes("part-1.ts"));
});

test("undecodable segments still fail closed when nothing decodable remains or the share is implausible", async (t) => {
    const root = await temporary(t);
    const stub = await undecodableStub(root, "stub", { size: "640x360" });
    await assert.rejects(async () => analyzeRecordingResolution(await assemble(root, [stub, stub])),
        /No playlist segment has an independently decodable video keyframe/);
    const short = await fixturePart(root, "short", { size: "640x360", frames: 3 });
    // 0.3 s of 0.6 s is far beyond capture stubs at quality switches.
    await assert.rejects(async () => analyzeRecordingResolution(await assemble(root, [short, stub])),
        /Undecodable segments cover 0\.300000s of 0\.600000s \(above 5%\); refusing to drop them/);
});

test("conversion drops the stub's picture and audio, keeps every decodable frame and validates", async (t) => {
    const root = await temporary(t);
    const { a, stub, b } = await parts(root, "640x360");
    const playlist = await assemble(root, [a, stub, b], durations([a, stub, b]));
    const original = await readFile(playlist, "utf8");
    const staging = path.join(root, "out");
    const result = await createDefaultStages(staging).remux({ id: "stubbed", playlistPath: playlist });
    assert.equal(path.basename(result.path), "stubbed.production-upscale1080p.mp4");
    assert.match(result.eventReason, dropNote);
    const expected = await concatenated(frameIds, [a, b]);
    const actual = await frameIds(result.path);
    assert.equal(new Set(expected).size, expected.length, "fixture IDs must be unique");
    assert.equal(actual.length, expected.length, "every decodable frame survives exactly once");
    // Conversion is lossy: each decoded marker must be nearest to its own source ID.
    actual.forEach((id, index) => {
        const distances = expected.map((candidate) => Math.abs(candidate - id));
        assert.equal(distances.indexOf(Math.min(...distances)), index, `frame ${index}: got luma ID ${id}`);
    });
    assert.deepEqual((await audioPackets(result.path)).map((packet) => packet.data_hash),
        (await concatenated(audioPackets, [a, b])).map((packet) => packet.data_hash), "stub audio is dropped with its segment");
    const validated = await validateArtifact(result.path);
    assert.deepEqual([validated.videoWidth, validated.videoHeight], [1920, 1080]);
    assert.equal(await readFile(playlist, "utf8"), original, "source playlist must remain byte-identical");
    assert.deepEqual(await readdir(staging), [path.basename(result.path)], "temporary input runs are cleaned up");
});

test("native and retained stream-copy remuxes exclude the stub and copy all other picture data", async (t) => {
    const root = await temporary(t);
    const { a, stub, b } = await parts(root, "1920x1080");
    const low = await fixturePart(root, "low", { size: "1280x720", frames: 1, offset: 60 });
    for (const [id, selection, expectedFile, disposition] of [
        ["native", [a, stub, b], "native.mp4", "remuxNative"],
        ["retained", [a, stub, low, b], "retained.retained1080p.mp4", "retain1080"],
    ]) {
        const directory = path.join(root, id);
        await mkdir(directory, { recursive: true });
        const playlist = await assemble(directory, selection, durations(selection));
        assert.equal(chooseRecordingResolutionPolicy(await analyzeRecordingResolution(playlist)).disposition, disposition);
        const result = await createDefaultStages(path.join(directory, "out")).remux({ id, playlistPath: playlist });
        assert.equal(path.basename(result.path), expectedFile);
        assert.match(result.eventReason, dropNote);
        assert.deepEqual(await videoSliceHashes(result.path), await concatenated(videoSliceHashes, [a, b]),
            "encoded picture data is copied, not re-encoded");
        assert.deepEqual(await frameIds(result.path), await concatenated(frameIds, [a, b]));
        await validateArtifact(result.path);
    }
});

test("a keyframe-less segment inside a continuous run decodes in sequence and is kept", async (t) => {
    const root = await temporary(t);
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    // One continuous 1280x720 stream, keyframe every 2 s, cut every 1 s with no
    // discontinuity tags: every second segment has no keyframe of its own.
    await promisify(execFile)("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=10:duration=4", "-c:v", "libx264", "-g", "20",
        "-keyint_min", "20", "-sc_threshold", "0", "-f", "hls", "-hls_time", "1", "-hls_flags", "split_by_time",
        "-hls_list_size", "0", "-hls_segment_filename", path.join(root, "seg%d.ts"), path.join(root, "playlist.m3u8")]);
    const playlist = path.join(root, "playlist.m3u8");
    const analysis = await analyzeRecordingResolution(playlist);
    assert.ok(analysis.segments.length >= 4);
    assert.deepEqual(analysis.undecodableSegments, []);
    assert.ok(analysis.segments.every((segment) => segment.width === 1280 && segment.height === 720));
    assert.doesNotMatch(chooseRecordingResolutionPolicy(analysis).reason, /no independently decodable/);
});
