import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeRecordingResolution, deriveResolutionPlaylist } from "../dist/stages/resolutionPolicy.js";
import { upscaleWholeRecordingTo1080 } from "../dist/stages/upscale.js";
import { streamCopyRemux } from "../dist/stages/remux.js";
import { createDefaultStages } from "../dist/stages/defaultStages.js";
import { fixturePart, assemble, frameIds, audioPackets, videoTimes, videoSliceHashes, exec } from "./helpers/mediaFixture.mjs";

async function temporary(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-fidelity-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}
function sameFrames(expected, actual) {
    assert.equal(actual.length, expected.length, "every intended frame must survive exactly once");
    // Conversion is lossy. Decode each luma marker to its nearest source ID;
    // fixed byte equality is only appropriate for the stream-copy tests.
    assert.equal(new Set(expected).size, expected.length, "fixture IDs must be unique");
    expected.forEach((id, index) => {
        const distances = expected.map((candidate) => Math.abs(candidate - actual[index]));
        const closest = Math.min(...distances);
        assert.equal(distances.indexOf(closest), index, `frame ${index}: expected luma ID ${id}, got ${actual[index]}`);
        assert.equal(distances.filter((distance) => distance === closest).length, 1, "frame ID must be unambiguous");
    });
}
async function sameAudio(parts, output) {
    const expected = (await Promise.all(parts.map((p) => audioPackets(p.input)))).flat();
    const actual = await audioPackets(output);
    assert.deepEqual(actual.map((p) => p.data_hash), expected.map((p) => p.data_hash), "all intended AAC packets in order");
    for (let i = 1; i < actual.length; i++) {
        assert(Number(actual[i].pts_time) > Number(actual[i - 1].pts_time), "audio timestamps must increase");
        assert(Number(actual[i].pts_time) - Number(actual[i - 1].pts_time) < 0.1, "no audio timeline hole at join");
    }
}

async function continuousVideo(output) {
    const times = await videoTimes(output);
    times.forEach((time, i) => assert(Math.abs(time - times[0] - i / 10) < 0.003,
        `frame ${i} presentation time ${time - times[0]} must be ${i / 10}`));
}

test("TS ownership uses packet positions with unequal GOP counts, repeated files and timestamp resets", async (t) => {
    const root = await temporary(t);
    const low = await fixturePart(root, "low", { gop: 2 });
    const high = await fixturePart(root, "high", { size: "640x360", gop: 6, offset: 60 });
    const playlist = await assemble(root, [low, high, high]);
    const analysis = await analyzeRecordingResolution(playlist);
    assert.deepEqual(analysis.segments.map((s) => [s.width, s.height]), [[320, 180], [640, 360], [640, 360]]);
    // Same file appears twice; byte intervals refer to occurrences, not names.
    await writeFile(playlist, (await readFile(playlist, "utf8")).replace("part-2.ts", "part-1.ts"));
    assert.deepEqual((await analyzeRecordingResolution(playlist)).segments.map((s) => s.width), [320, 640, 640]);
    await writeFile(path.join(root, "part-0.ts"), Buffer.concat([await readFile(low.input), await readFile(high.input)]));
    await assert.rejects(() => analyzeRecordingResolution(playlist), /inside segment/);
});

for (const fmp4 of [false, true]) {
    test(`${fmp4 ? "fMP4" : "TS"} conversion preserves distinct frames and AAC across resolution resets`, async (t) => {
        const root = await temporary(t);
        const parts = [];
        for (const [index, size] of ["320x180", "640x360", "320x180"].entries()) {
            parts.push(await fixturePart(root, `p${index}`, { size, offset: index * 60, fmp4 }));
        }
        const playlist = await assemble(root, parts);
        const expected = (await Promise.all(parts.map((p) => frameIds(p.input)))).flat();
        const result = await upscaleWholeRecordingTo1080(playlist, path.join(root, "out"), "mixed", {
            width: 640, height: 360, sampleAspectRatio: "1:1",
        });
        sameFrames(expected, await frameIds(result.path));
        await continuousVideo(result.path);
        await sameAudio(parts, result.path);
    });
}

for (const portrait of [false, true]) {
for (const resetTimestamps of [false, true]) {
    test(`production untagged TS 360p/720p/360p conversion: ${portrait ? "portrait" : "landscape"}, ${resetTimestamps ? "reset" : "continuous"} timestamps`, async (t) => {
        const root = await temporary(t);
        const sizes = portrait ? ["360x640", "720x1280", "360x640"] : ["640x360", "1280x720", "640x360"];
        const parts = [];
        for (const [index, size] of sizes.entries()) {
            parts.push(await fixturePart(root, `p${index}`, { size, frames: 4, offset: index * 60,
                timestampOffset: resetTimestamps ? 0 : index * 0.4 }));
        }
        const playlist = await assemble(root, parts);
        const original = (await readFile(playlist, "utf8")).replaceAll("#EXT-X-DISCONTINUITY\n", "");
        await writeFile(playlist, original);
        assert(!original.includes("#EXT-X-DISCONTINUITY"));
        const staging = path.join(root, "out");
        const result = await createDefaultStages(staging).remux({ id: "untagged", playlistPath: playlist });
        assert.equal(path.basename(result.path), "untagged.production-upscale1080p.mp4");
        sameFrames((await Promise.all(parts.map((p) => frameIds(p.input)))).flat(), await frameIds(result.path));
        await continuousVideo(result.path);
        await sameAudio(parts, result.path);
        const { stdout } = await exec("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
            "stream=width,height,sample_aspect_ratio", "-of", "json", result.path]);
        assert.deepEqual(JSON.parse(stdout).streams[0], { width: portrait ? 1080 : 1920,
            height: portrait ? 1920 : 1080, sample_aspect_ratio: "1:1" });
        assert.equal(await readFile(playlist, "utf8"), original, "source playlist must remain byte-identical");
        assert.deepEqual(await readdir(staging), [path.basename(result.path)], "temporary input runs are cleaned up");
    });
}
}

test("fMP4 retained remux preserves exact decoded frames and AAC for prefix, suffix and repeated cuts", async (t) => {
    const root = await temporary(t);
    const parts = [];
    for (let i = 0; i < 5; i++) parts.push(await fixturePart(root, `p${i}`, { size: "1920x1080", frames: 3, offset: i * 35, fmp4: true }));
    const playlist = await assemble(root, parts);
    const analysis = await analyzeRecordingResolution(playlist);
    for (const indexes of [[1, 2, 3, 4], [0, 1, 2, 3], [0, 2, 4], [0, 1, 2, 3, 4]]) {
        const kept = parts.filter((_, i) => indexes.includes(i));
        const derived = path.join(root, "derived.m3u8");
        await writeFile(derived, deriveResolutionPlaylist(analysis, new Set(indexes)));
        const output = await streamCopyRemux(derived, path.join(root, "out"), `kept-${indexes.join("-")}`);
        const expected = (await Promise.all(kept.map((p) => frameIds(p.input)))).flat();
        assert.deepEqual(await frameIds(output), expected, "stream-copy retains exact decoded frame IDs");
        await continuousVideo(output);
        await sameAudio(kept, output);
    }
});

test("production pure 1440p passes through the native remux branch unchanged", async (t) => {
    const root = await temporary(t);
    const part = await fixturePart(root, "native", { size: "2560x1440", frames: 3, fmp4: true });
    const playlist = await assemble(root, [part]);
    const result = await createDefaultStages(path.join(root, "out")).remux({ id: "native", playlistPath: playlist });
    assert.equal(path.basename(result.path), "native.mp4");
    const { stdout } = await (await import("./helpers/mediaFixture.mjs")).exec("ffprobe", ["-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "json", result.path]);
    assert.deepEqual(JSON.parse(stdout).streams[0], { width: 2560, height: 1440 });
    assert.deepEqual(await frameIds(result.path), await frameIds(part.input));
    await sameAudio([part], result.path);
});

for (const fmp4 of [false, true]) {
test(`${fmp4 ? "fMP4" : "TS"} production remux preserves mixed 1080p/1440p and removes only low-resolution content`, async (t) => {
    const root = await temporary(t);
    const full = await fixturePart(root, "full", { size: "1920x1080", frames: 5, fmp4 });
    const higher = await fixturePart(root, "higher", { size: "2560x1440", frames: 5, offset: 80, fmp4 });
    const low = await fixturePart(root, "low", { size: "1280x720", frames: 1, offset: 150, fmp4 });
    for (const [name, parts, expectedFile] of [["native", [full, higher], "native.mp4"],
        ["retained", [full, low, higher], "retained.retained1080p.mp4"]]) {
        const playlist = await assemble(root, parts);
        const result = await createDefaultStages(path.join(root, "out")).remux({ id: name, playlistPath: playlist });
        assert.equal(path.basename(result.path), expectedFile);
        const expectedIds = [...await frameIds(full.input), ...await frameIds(higher.input)];
        assert.deepEqual(await frameIds(result.path), expectedIds);
        const expectedSlices = [...await videoSliceHashes(full.input), ...await videoSliceHashes(higher.input)];
        assert(expectedSlices.length > 0);
        assert.deepEqual(await videoSliceHashes(result.path), expectedSlices, "encoded picture data is copied, not re-encoded");
        await continuousVideo(result.path);
        await sameAudio([full, higher], result.path);
        const { stdout } = await exec("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_frames",
            "-show_entries", "frame=width,height", "-of", "json", result.path]);
        assert.deepEqual(JSON.parse(stdout).frames.map((f) => [f.width, f.height]),
            [...Array.from({ length: 5 }, () => [1920, 1080]), ...Array.from({ length: 5 }, () => [2560, 1440])],
            "native coded dimensions survive each frame without conversion");
    }
});
}

test("below-threshold mixed 1440p/720p converts ALL frames to unpadded 1080p with non-16:9 aspect in both orientations", async (t) => {
    const root = await temporary(t);
    for (const portrait of [false, true]) {
        const dir = path.join(root, portrait ? "portrait" : "landscape");
        const high = await fixturePart(dir, "high", { size: portrait ? "1440x2640" : "2640x1440", frames: 2, fmp4: true });
        const low = await fixturePart(dir, "low", { size: portrait ? "720x1320" : "1320x720", offset: 60, frames: 4, fmp4: true });
        const playlist = await assemble(dir, [high, low]);
        const result = await createDefaultStages(path.join(dir, "out")).remux({ id: "converted", playlistPath: playlist });
        assert.equal(path.basename(result.path), "converted.production-upscale1080p.mp4");
        sameFrames([...await frameIds(high.input), ...await frameIds(low.input)], await frameIds(result.path));
        await continuousVideo(result.path);
        await sameAudio([high, low], result.path);
        const { stdout } = await exec("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
            "stream=width,height,sample_aspect_ratio", "-of", "json", result.path]);
        assert.deepEqual(JSON.parse(stdout).streams[0], { width: portrait ? 1080 : 1980,
            height: portrait ? 1980 : 1080, sample_aspect_ratio: "1:1" });
    }
});

test("custom 2560x900 qualifies by pixel count and is remuxed without conversion or padding", async (t) => {
    const root = await temporary(t);
    const high = await fixturePart(root, "wide", { size: "2560x900", frames: 5, fmp4: true });
    const low = await fixturePart(root, "low", { size: "1280x450", frames: 1, offset: 100, fmp4: true });
    for (const [id, parts, kept] of [["native", [high], [high]], ["retained", [high, low, high], [high, high]]]) {
        const playlist = await assemble(root, parts);
        const result = await createDefaultStages(path.join(root, "out")).remux({ id, playlistPath: playlist });
        assert.equal(path.basename(result.path), id === "native" ? "native.mp4" : "retained.retained1080p.mp4");
        assert.deepEqual(await videoSliceHashes(result.path), (await Promise.all(kept.map((p) => videoSliceHashes(p.input)))).flat());
        assert.deepEqual(await frameIds(result.path), (await Promise.all(kept.map((p) => frameIds(p.input)))).flat());
        await continuousVideo(result.path);
        await sameAudio(kept, result.path);
        const { stdout } = await exec("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
            "stream=width,height", "-of", "json", result.path]);
        assert.deepEqual(JSON.parse(stdout).streams[0], { width: 2560, height: 900 });
    }
});
