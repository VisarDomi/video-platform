import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeRecordingResolution, deriveResolutionPlaylist, productionOutputDimensions } from "../dist/stages/resolutionPolicy.js";
import { convertShapeGroup } from "../dist/stages/upscale.js";
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
    // Two picture sizes inside one segment: reported, measured by the larger one, never refused.
    await writeFile(path.join(root, "part-0.ts"), Buffer.concat([await readFile(low.input), await readFile(high.input)]));
    const mixed = await analyzeRecordingResolution(playlist);
    assert.deepEqual(mixed.segments.map((s) => s.width), [640, 640, 640]);
    assert.match(mixed.warnings.join("; "), /picture size changes inside segment .*part-0\.ts/);
});

for (const size of ["640x480", "480x640", "960x768", "768x960"]) {
    test(`real conversion keeps every frame and AAC packet, unpadded, at the production size: ${size}`, async t => {
        const root = await temporary(t);
        const part = await fixturePart(root, "narrow", { size, frames: 4, fmp4: true });
        const playlist = await assemble(root, [part]);
        const [width,height] = size.split("x").map(Number);
        const output = productionOutputDimensions({width,height,sampleAspectRatio:"1:1"});
        assert.equal(output.rotate, height > width);
        const out = await convertShapeGroup(playlist,path.join(root,"out"),"narrow",{ output },"production-v5");
        sameFrames(await frameIds(part.input),await frameIds(out.path));
        await sameAudio([part],out.path);
        await continuousVideo(out.path);
        const {stdout} = await exec("ffprobe",["-v","error","-select_streams","v:0","-show_entries",
            "stream=width,height,sample_aspect_ratio","-of","json",out.path]);
        assert.deepEqual(JSON.parse(stdout).streams[0],{width:output.width,height:output.height,sample_aspect_ratio:"1:1"});
        // The source has uniform luma per frame. Padding would introduce a
        // dark border; inspect corners and centre of the actual encoded frame.
        const {stdout:pixels} = await exec("ffmpeg",["-v","error","-i",out.path,"-frames:v","1",
            "-vf","scale=3:3:flags=neighbor,format=gray","-f","rawvideo","pipe:1"],{encoding:"buffer"});
        assert(Math.max(...pixels)-Math.min(...pixels)<=2,"no added border/padding");
    });
}

for (const fmp4 of [false, true]) {
    test(`${fmp4 ? "fMP4" : "TS"} conversion preserves distinct frames and AAC across resolution resets`, async (t) => {
        const root = await temporary(t);
        const parts = [];
        for (const [index, size] of ["320x180", "640x360", "320x180"].entries()) {
            parts.push(await fixturePart(root, `p${index}`, { size, offset: index * 60, fmp4 }));
        }
        const playlist = await assemble(root, parts);
        const expected = (await Promise.all(parts.map((p) => frameIds(p.input)))).flat();
        const output = productionOutputDimensions({ width: 640, height: 360, sampleAspectRatio: "1:1" });
        const result = await convertShapeGroup(playlist, path.join(root, "out"), "mixed", { output }, "production-v5");
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
        assert.equal(path.basename(result.path), `untagged.production-v5${portrait ? "-ccw" : ""}.mp4`);
        sameFrames((await Promise.all(parts.map((p) => frameIds(p.input)))).flat(), await frameIds(result.path));
        await continuousVideo(result.path);
        await sameAudio(parts, result.path);
        const { stdout } = await exec("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
            "stream=width,height,sample_aspect_ratio", "-of", "json", result.path]);
        // Portrait is turned 90° counterclockwise: always a landscape Full HD frame.
        assert.deepEqual(JSON.parse(stdout).streams[0], { width: 1920, height: 1080, sample_aspect_ratio: "1:1" });
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

test("production pure 1440p is converted at its own size, never shrunk", async (t) => {
    const root = await temporary(t);
    const part = await fixturePart(root, "native", { size: "2560x1440", frames: 3, fmp4: true });
    const playlist = await assemble(root, [part]);
    const result = await createDefaultStages(path.join(root, "out")).remux({ id: "native", playlistPath: playlist });
    assert.equal(path.basename(result.path), "native.production-v5.mp4");
    const { stdout } = await exec("ffprobe", ["-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "json", result.path]);
    assert.deepEqual(JSON.parse(stdout).streams[0], { width: 2560, height: 1440 });
    sameFrames(await frameIds(part.input), await frameIds(result.path));
    await sameAudio([part], result.path);
});

for (const fmp4 of [false, true]) {
test(`${fmp4 ? "fMP4" : "TS"} production keeps mixed 1080p/720p/1440p content, all at the largest size`, async (t) => {
    const root = await temporary(t);
    const full = await fixturePart(root, "full", { size: "1920x1080", frames: 5, fmp4 });
    const low = await fixturePart(root, "low", { size: "1280x720", frames: 1, offset: 150, fmp4 });
    const higher = await fixturePart(root, "higher", { size: "2560x1440", frames: 5, offset: 80, fmp4 });
    const parts = [full, low, higher];
    const playlist = await assemble(root, parts);
    const result = await createDefaultStages(path.join(root, "out")).remux({ id: "mixed", playlistPath: playlist });
    assert.equal(path.basename(result.path), "mixed.production-v5.mp4");
    sameFrames((await Promise.all(parts.map((p) => frameIds(p.input)))).flat(), await frameIds(result.path));
    await continuousVideo(result.path);
    await sameAudio(parts, result.path);
    const { stdout } = await exec("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_frames",
        "-show_entries", "frame=width,height", "-of", "json", result.path]);
    assert.deepEqual(JSON.parse(stdout).frames.map((f) => [f.width, f.height]),
        Array.from({ length: 11 }, () => [2560, 1440]), "every frame, low ones included, at the largest size");
});
}

test("mixed 2640x1440/1320x720 keeps every frame at 2640x1440 in both orientations (never shrunk to 1080)", async (t) => {
    const root = await temporary(t);
    for (const portrait of [false, true]) {
        const dir = path.join(root, portrait ? "portrait" : "landscape");
        const high = await fixturePart(dir, "high", { size: portrait ? "1440x2640" : "2640x1440", frames: 2, fmp4: true });
        const low = await fixturePart(dir, "low", { size: portrait ? "720x1320" : "1320x720", offset: 60, frames: 4, fmp4: true });
        const playlist = await assemble(dir, [high, low]);
        const result = await createDefaultStages(path.join(dir, "out")).remux({ id: "converted", playlistPath: playlist });
        assert.equal(path.basename(result.path), `converted.production-v5${portrait ? "-ccw" : ""}.mp4`);
        sameFrames([...await frameIds(high.input), ...await frameIds(low.input)], await frameIds(result.path));
        await continuousVideo(result.path);
        await sameAudio([high, low], result.path);
        const { stdout } = await exec("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
            "stream=width,height,sample_aspect_ratio", "-of", "json", result.path]);
        assert.deepEqual(JSON.parse(stdout).streams[0], { width: 2640, height: 1440, sample_aspect_ratio: "1:1" });
    }
});

test("a wide 2560x900 recording is scaled to 1080 tall (Porntrex tiers by height) with nothing dropped", async (t) => {
    const root = await temporary(t);
    const high = await fixturePart(root, "wide", { size: "2560x900", frames: 5, fmp4: true });
    const low = await fixturePart(root, "low", { size: "1280x450", frames: 1, offset: 100, fmp4: true });
    const parts = [high, low, high];
    const playlist = await assemble(root, parts);
    const result = await createDefaultStages(path.join(root, "out")).remux({ id: "wide", playlistPath: playlist });
    assert.equal(path.basename(result.path), "wide.production-v5.mp4");
    const expected = (await Promise.all(parts.map((p) => frameIds(p.input)))).flat();
    const actual = await frameIds(result.path);
    assert.equal(actual.length, expected.length, "every frame, the low one included");
    await continuousVideo(result.path);
    await sameAudio(parts, result.path);
    const { stdout } = await exec("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
        "stream=width,height", "-of", "json", result.path]);
    assert.deepEqual(JSON.parse(stdout).streams[0], { width: 3072, height: 1080 });
});

for (const [label, jump] of [["back past the run start (read as a clock wrap)", -990], ["back a few seconds", -5], ["forward", 500]]) {
    test(`an untagged TS timestamp jump ${label} starts a new run: every frame, on the playlist timeline`, async (t) => {
        const root = await temporary(t);
        const parts = [];
        for (const [index, timestampOffset] of [0, 1000, 1000.4 + jump].entries()) {
            parts.push(await fixturePart(root, `p${index}`, { frames: 4, offset: index * 60, timestampOffset }));
        }
        const playlist = await assemble(root, parts);
        // The tag before part 1 makes the conversion read per-run inputs; part 2 jumps without one.
        const original = (await readFile(playlist, "utf8")).replace("#EXT-X-DISCONTINUITY\n#EXTINF:0.4,\npart-2.ts", "#EXTINF:0.4,\npart-2.ts");
        await writeFile(playlist, original);
        assert.equal(original.match(/#EXT-X-DISCONTINUITY/g).length, 1);
        const result = await createDefaultStages(path.join(root, "out")).remux({ id: "jump", playlistPath: playlist });
        sameFrames((await Promise.all(parts.map((p) => frameIds(p.input)))).flat(), await frameIds(result.path));
        await continuousVideo(result.path);
        await sameAudio(parts, result.path);
        assert.equal(await readFile(playlist, "utf8"), original, "source playlist must remain byte-identical");
    });
}

test("a conversion longer than its segments fails and leaves no artifact", async (t) => {
    const root = await temporary(t);
    const part = await fixturePart(root, "long", { frames: 70 });
    const playlist = await assemble(root, [part], [0.4]);
    const staging = path.join(root, "out");
    await assert.rejects(createDefaultStages(staging).remux({ id: "long", playlistPath: playlist }),
        /lasts 7\.\d s, longer than its 0\.4 s of segments/);
    assert.deepEqual(await readdir(staging), [], "no artifact or temporary input is left behind");
});
