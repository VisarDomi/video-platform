import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    analyzeRecordingResolution,
    deriveResolutionPlaylist,
    planRecordingShapes,
} from "../dist/stages/resolutionPolicy.js";
import { createDefaultStages } from "../dist/stages/defaultStages.js";
import { validateArtifact } from "../dist/stages/validateArtifact.js";
import { fixturePart, undecodableStub, assemble, frameIds, exec } from "./helpers/mediaFixture.mjs";

async function temporary(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-undecodable-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}

async function concatenated(read, parts) {
    return (await Promise.all(parts.map((part) => read(part.input)))).flat();
}

// Live stubs are short; a 0.1 s EXTINF is typical of quality-switch leftovers.
const STUB_SECONDS = 0.1;
const durations = (parts) => parts.map((part) => part.stub ? STUB_SECONDS : part.frames / 10);
const keptNote = /1 segment\(s\) start without a decodable keyframe and are converted with the picture that follows \(part-1\.ts 0\.100000s; total 0\.100000s\)/;

async function audioSeconds(input) {
    const { stdout } = await exec("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=duration", "-of", "csv=p=0", input]);
    return Number(stdout.trim());
}

async function parts(root, size) {
    // Unique luma IDs across both decodable parts (30..118 and 130..218).
    const a = await fixturePart(root, "a", { size, frames: 12 });
    const stub = { ...await undecodableStub(root, "stub", { size }), stub: true };
    const b = await fixturePart(root, "b", { size, frames: 12, offset: 100 });
    return { a, stub, b };
}

test("a TS stub without a decodable keyframe is kept, with the picture that follows it", async (t) => {
    const root = await temporary(t);
    const { a, stub, b } = await parts(root, "640x360");
    const playlist = await assemble(root, [a, stub, b], durations([a, stub, b]));
    const analysis = await analyzeRecordingResolution(playlist);
    assert.deepEqual(analysis.segments.map((segment) => segment.index), [0, 2]);
    assert.deepEqual(analysis.undecodableSegments, [{ index: 1, name: "part-1.ts", durationSeconds: STUB_SECONDS }]);
    assert.equal(analysis.resolutionSummary, "640x360:2");
    assert.match(analysis.warnings.join("; "), keptNote);
    const plan = planRecordingShapes(analysis);
    assert.equal(plan.upload.length, 1);
    assert.equal(plan.upload[0].part, "full");
    assert.deepEqual([...plan.upload[0].indexes].sort(), [0, 1, 2]);
    assert.match(plan.reason, keptNote);
    assert(deriveResolutionPlaylist(analysis, new Set([0, 1, 2])).includes("part-1.ts"));
});

test("a recording without any picture still fails; a large unmeasurable share is only a warning", async (t) => {
    const root = await temporary(t);
    const stub = await undecodableStub(root, "stub", { size: "640x360" });
    await assert.rejects(async () => analyzeRecordingResolution(await assemble(root, [stub, stub])),
        /No playlist segment has an independently decodable video keyframe/);
    const short = await fixturePart(root, "short", { size: "640x360", frames: 3 });
    // 0.3 s of 0.6 s is far beyond capture stubs at quality switches: tell a person, keep it.
    const analysis = await analyzeRecordingResolution(await assemble(root, [short, stub]));
    assert.match(analysis.warnings.join("; "), /over 5% of the recording, check the capture/);
    assert.deepEqual([...planRecordingShapes(analysis).upload[0].indexes].sort(), [0, 1]);
});

test("conversion keeps the stub: no garbage picture, every decodable frame once, the stub's audio time kept", async (t) => {
    const root = await temporary(t);
    const { a, stub, b } = await parts(root, "640x360");
    const playlist = await assemble(root, [a, stub, b], durations([a, stub, b]));
    const original = await readFile(playlist, "utf8");
    const staging = path.join(root, "out");
    const result = await createDefaultStages(staging).remux({ id: "stubbed", playlistPath: playlist });
    assert.equal(path.basename(result.path), "stubbed.production-v5.mp4");
    assert.match(result.eventReason, keptNote);
    const [fromA, fromB] = [await frameIds(a.input), await frameIds(b.input)];
    assert.equal(new Set([...fromA, ...fromB]).size, fromA.length + fromB.length, "fixture IDs must be unique");
    // The stub's 0.1 s has no picture: the last picture before it is held (one
    // frame at 10 fps), never garbage decoded against the wrong parameters.
    const expected = [...fromA, fromA.at(-1), ...fromB];
    const actual = await frameIds(result.path);
    assert.equal(actual.length, expected.length, "every decodable frame exactly once, plus the held frame");
    // Conversion is lossy: each decoded marker must be nearest to its own source ID.
    // Conversion is lossy: map each decoded marker to the nearest source ID.
    const ids = [...fromA, ...fromB];
    const nearest = (id) => ids.reduce((best, candidate) => Math.abs(candidate - id) < Math.abs(best - id) ? candidate : best);
    assert.deepEqual(actual.map(nearest), expected);
    const total = durations([a, stub, b]).reduce((sum, value) => sum + value, 0);
    assert(Math.abs(await audioSeconds(result.path) - total) < 0.08, "the stub's second of audio is kept in place");
    const validated = await validateArtifact(result.path);
    assert.deepEqual([validated.videoWidth, validated.videoHeight], [1920, 1080]);
    assert.equal(await readFile(playlist, "utf8"), original, "source playlist must remain byte-identical");
    assert.deepEqual(await readdir(staging), [path.basename(result.path)], "temporary input runs are cleaned up");
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
    assert.doesNotMatch(planRecordingShapes(analysis).reason, /without a decodable keyframe/);
});
