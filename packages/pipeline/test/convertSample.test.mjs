import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildUpscaleTranscodeArgs } from "../dist/stages/upscale.js";
import { videoEncoderArgs, videoEncoderLabel } from "../dist/stages/videoEncoder.js";
import { convertSample } from "../dist/commands/convertSample.js";

const plan = { outputWidth: 1920, outputHeight: 1080, selectExpression: null };

test("production conversion stays x264 slow at CRF 16 unless another encoder is named", () => {
    const args = buildUpscaleTranscodeArgs("in.m3u8", "out.mp4", plan);
    const at = args.indexOf("-c:v");
    assert.deepEqual(args.slice(at, at + 8), ["-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p"]);
    assert.equal(videoEncoderLabel({ kind: "x264" }), "x264-slow-crf16");
});

test("NVENC runs its best preset at constant quality, with the same filters and container", () => {
    const nvenc = buildUpscaleTranscodeArgs("in.m3u8", "out.mp4", plan, undefined, { kind: "nvenc", cq: 18 });
    const x264 = buildUpscaleTranscodeArgs("in.m3u8", "out.mp4", plan);
    const outside = (args) => args.filter((_, i) => i < args.indexOf("-c:v") || i >= args.indexOf("-fps_mode:v"));
    assert.deepEqual(outside(nvenc), outside(x264));
    const encoder = videoEncoderArgs({ kind: "nvenc", cq: 18 });
    for (const [flag, value] of [["-c:v", "h264_nvenc"], ["-preset", "p7"], ["-rc", "vbr"], ["-cq", "18"], ["-b:v", "0"], ["-multipass", "fullres"]]) {
        assert.equal(encoder[encoder.indexOf(flag) + 1], value, flag);
    }
    assert.equal(videoEncoderLabel({ kind: "nvenc", cq: 18 }), "nvenc-p7-cq18");
    assert.throws(() => videoEncoderArgs({ kind: "nvenc", cq: 0 }), /1 to 51/);
});

test("a sample is converted into the caller's folder, never over an existing file, and nothing is left behind", async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "convert-sample-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, "2026-01-01 000000 sample");
    mkdirSync(source);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=4", "-f", "lavfi", "-i", "sine=d=4",
        "-c:v", "libx264", "-g", "60", "-c:a", "aac", "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod",
        path.join(source, "playlist.m3u8")]);
    const out = path.join(root, "out");
    mkdirSync(out);
    const [result, ...rest] = await convertSample(source, out, { kind: "x264" });
    assert.equal(rest.length, 0);
    assert.equal(path.basename(result.path), "2026-01-01 000000 sample.x264-slow-crf16.mp4");
    const height = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0", result.path]).toString().trim();
    assert.equal(height, "1080");
    assert.deepEqual(readdirSync(out), [path.basename(result.path)]);
    await assert.rejects(convertSample(source, out, { kind: "x264" }), /never replaced/);
    assert.deepEqual(readdirSync(out), [path.basename(result.path)]);
});
