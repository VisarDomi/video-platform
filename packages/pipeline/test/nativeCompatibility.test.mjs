import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fixturePart, assemble, frameIds, videoTimes, exec } from "./helpers/mediaFixture.mjs";
import { createDefaultStages } from "../dist/stages/defaultStages.js";
import { validateArtifact } from "../dist/stages/validateArtifact.js";
import { nativeStreamCompatibility } from "../dist/stages/mediaCompatibility.js";

async function temporary(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "native-compatibility-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}

async function checkFrames(parts, output) {
    const expected = (await Promise.all(parts.map(part => frameIds(part.input)))).flat();
    const actual = await frameIds(output);
    assert.equal(actual.length, expected.length, "keep every selected frame once");
    actual.forEach((frame, index) => assert(Math.abs(frame - expected[index]) <= 3, `frame ${index} must survive conversion`));
    const times = await videoTimes(output);
    times.forEach((time, index) => assert(Math.abs(time - times[0] - index / 10) < 0.003,
        `frame ${index} must retain its continuous presentation time`));
}

test("compatibility distinguishes codec, audio presence/format and timebase without requiring identical H264 geometry", () => {
    const video = { codec_type: "video", codec_name: "h264", time_base: "1/90000", pix_fmt: "yuv420p" };
    const audio = { codec_type: "audio", codec_name: "aac", time_base: "1/48000", sample_rate: "48000", channels: 1 };
    assert.equal(nativeStreamCompatibility([[video, audio], [video, audio]]), null);
    for (const changed of [[{ ...video, codec_name: "av1" }, audio], [video],
        [video, { ...audio, sample_rate: "44100" }], [{ ...video, time_base: "1/15360" }, audio]]) {
        assert.match(nativeStreamCompatibility([[video, audio], changed]), /changes/);
    }
});

for (const portrait of [false, true]) {
    test(`high-pixel AV1/H264 falls back to ONE unpadded conversion: ${portrait ? "portrait" : "landscape"}`, async t => {
        const root = await temporary(t);
        const size = portrait ? "1080x1920" : "1920x1080";
        const parts = [await fixturePart(root, "av1", { size, frames: 3, fmp4: true, codec: "libaom-av1" }),
            await fixturePart(root, "h264", { size, frames: 3, offset: 70, fmp4: true })];
        const playlist = await assemble(root, parts);
        const original = await readFile(playlist, "utf8");
        const result = await createDefaultStages(path.join(root, "out")).remux({ id: "mixed-codec", playlistPath: playlist });
        assert.equal(path.basename(result.path), "mixed-codec.compatibility-upscale1080p.mp4");
        assert.match(result.eventReason, /compatibility-conversion-v1/);
        await checkFrames(parts, result.path);
        const artifact = await validateArtifact(result.path);
        assert.equal(artifact.videoWidth, portrait ? 1080 : 1920);
        assert.equal(artifact.videoHeight, portrait ? 1920 : 1080);
        assert.equal(await readFile(playlist, "utf8"), original);
        assert.deepEqual(await readdir(path.join(root, "out")), [path.basename(result.path)]);
    });
}

test("audio appears/disappears without shifting later audio, losing frames or truncating a silent opening", async t => {
    const root = await temporary(t);
    const parts = [await fixturePart(root, "silent-open", { frames: 4, audio: false, fmp4: true }),
        await fixturePart(root, "sound", { frames: 4, offset: 70, audioOffset: 0.1, fmp4: true }),
        await fixturePart(root, "silent-end", { frames: 4, offset: 140, audio: false, fmp4: true })];
    const playlist = await assemble(root, parts);
    const result = await createDefaultStages(path.join(root, "out")).remux({ id: "audio-change", playlistPath: playlist });
    await checkFrames(parts, result.path);
    const artifact = await validateArtifact(result.path);
    assert.equal(artifact.audioCodec, "aac");
    const { stdout } = await exec("ffmpeg", ["-v", "error", "-i", result.path, "-map", "0:a:0",
        "-ar", "48000", "-ac", "1", "-f", "f32le", "pipe:1"], { encoding: "buffer", maxBuffer: 1000000 });
    const rms = (start, end) => {
        let sum = 0, count = 0;
        for (let i = Math.ceil(start * 48000); i < Math.floor(end * 48000) && i * 4 + 4 <= stdout.length; i++) {
            const sample = stdout.readFloatLE(i * 4); sum += sample * sample; count++;
        }
        return Math.sqrt(sum / count);
    };
    assert(rms(0.05, 0.35) < 0.0001, "silent opening must remain silent");
    assert(rms(0.41, 0.47) < 0.0002, "native audio offset must not be reset independently of video");
    assert(rms(0.55, 0.72) > 0.02, "later sound must be retained at the right time");
    assert(rms(0.95, 1.15) < 0.0001, "silent ending must remain silent");
});

test("90% selection precedes compatibility fallback; no excluded low-resolution content reappears", async t => {
    const root = await temporary(t);
    const high = [await fixturePart(root, "av1", { size: "1920x1080", frames: 3, fmp4: true, codec: "libaom-av1" }),
        await fixturePart(root, "h264", { size: "1920x1080", frames: 3, offset: 70, fmp4: true })];
    const low = await fixturePart(root, "low", { frames: 1, offset: 140, fmp4: true });
    const playlist = await assemble(root, [high[0], low, high[1]], [0.3, 0.06, 0.3]);
    const result = await createDefaultStages(path.join(root, "out")).remux({ id: "retained", playlistPath: playlist });
    assert.match(result.eventReason, /keep 2 qualifying segments and drop 1/);
    await checkFrames(high, result.path);
});
