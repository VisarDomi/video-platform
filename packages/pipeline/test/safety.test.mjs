import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
    containedArtifactPath,
    buildStreamCopyRemuxArgs,
    streamCopyRemux,
} from "../dist/stages/remux.js";
import {
    buildUpscaleTranscodeArgs,
    createUpscalePlan,
    upscaleTranscode,
} from "../dist/stages/upscale.js";
import { parseRemuxOneArguments } from "../dist/commands/remuxOneArguments.js";
import { validateArtifact } from "../dist/stages/validateArtifact.js";
import { DisabledXvideosUploader } from "../dist/upload/disabledXvideosUploader.js";
import { UploadByteMeter } from "../dist/upload/uploadCoordinator.js";

const execFileAsync = promisify(execFile);

test("artifact paths are contained and stream-copy remux leaves threading to ffmpeg", () => {
    const id = "d".repeat(64);
    assert.equal(containedArtifactPath("/tmp/staging", id), `/tmp/staging/${id}.mp4`);
    assert.throws(() => containedArtifactPath("/tmp/staging", "../escape"), /Invalid recording ID/);
    assert.equal(
        containedArtifactPath("/tmp/staging", id, "upscale1080p"),
        `/tmp/staging/${id}.upscale1080p.mp4`,
    );
    assert.throws(() => containedArtifactPath("/tmp/staging", id, "../escape"), /Invalid artifact suffix/);
    const args = buildStreamCopyRemuxArgs("/source/playlist.m3u8", "/staging/output.partial");
    assert.deepEqual(args.slice(args.indexOf("-c"), args.indexOf("-c") + 2), ["-c", "copy"]);
    assert(args.includes("-nostdin"));
    assert(!args.includes("-threads"));
    assert(!args.includes("-filter_threads"));
    assert(!args.includes("-filter_complex_threads"));
    assert(!args.includes("-y"));
});

test("remux-one accepts exactly one optional upscale flag in either argument order", () => {
    assert.deepEqual(parseRemuxOneArguments(["--recording", "/recording"]), {
        recordingPath: "/recording",
        upscaleMode: null,
    });
    assert.deepEqual(parseRemuxOneArguments(["--upscale1080p", "--recording", "/recording"]), {
        recordingPath: "/recording",
        upscaleMode: "upscale1080p",
    });
    assert.deepEqual(parseRemuxOneArguments(["--recording", "/recording", "--upscale1440p"]), {
        recordingPath: "/recording",
        upscaleMode: "upscale1440p",
    });
    assert.throws(
        () => parseRemuxOneArguments(["--recording", "/recording", "--upscale1080p", "--upscale1440p"]),
        /at most one upscale flag/,
    );
    assert.throws(() => parseRemuxOneArguments(["--recording", "/recording", "--wat"]), /Unknown/);
    assert.throws(() => parseRemuxOneArguments(["--upscale1080p"]), /requires exactly one/);
});

test("upscale plans preserve display orientation and aspect ratio without crop or padding", () => {
    const landscape1080 = createUpscalePlan([
        { width: 1280, height: 720, sampleAspectRatio: "1:1" },
    ], "upscale1080p");
    assert.equal(landscape1080.outputWidth, 1920);
    assert.equal(landscape1080.outputHeight, 1080);

    const portrait1080 = createUpscalePlan([
        { width: 720, height: 1280, sampleAspectRatio: "1:1" },
    ], "upscale1080p");
    assert.equal(portrait1080.outputWidth, 1080);
    assert.equal(portrait1080.outputHeight, 1920);

    const landscape1440 = createUpscalePlan([
        { width: 1920, height: 1080, sampleAspectRatio: "1:1" },
    ], "upscale1440p");
    assert.equal(landscape1440.outputWidth, 2560);
    assert.equal(landscape1440.outputHeight, 1440);

    const nonStandardAspect = createUpscalePlan([
        { width: 1980, height: 1080, sampleAspectRatio: "1:1" },
    ], "upscale1440p");
    assert.equal(nonStandardAspect.outputWidth, 2640);
    assert.equal(nonStandardAspect.outputHeight, 1440);

    const args = buildUpscaleTranscodeArgs("/source.m3u8", "/output.mp4", portrait1080);
    const filter = args[args.indexOf("-vf") + 1];
    assert.equal(filter, "zscale=w=1080:h=1920:filter=lanczos,setsar=1");
    assert(!filter.includes("pad"));
    assert(!filter.includes("crop"));
    assert.deepEqual(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2), ["-c:v", "libx264"]);
    assert.deepEqual(args.slice(args.indexOf("-preset"), args.indexOf("-preset") + 2), ["-preset", "slow"]);
    assert.deepEqual(args.slice(args.indexOf("-crf"), args.indexOf("-crf") + 2), ["-crf", "16"]);
    assert.deepEqual(args.slice(args.indexOf("-c:a"), args.indexOf("-c:a") + 2), ["-c:a", "copy"]);
    assert(!args.includes("-threads"));
});

test("upscale plans drop below-floor frames and refuse ambiguous inputs", () => {
    const plan = createUpscalePlan([
        { width: 640, height: 360, sampleAspectRatio: "1:1" },
        { width: 640, height: 360, sampleAspectRatio: "1:1" },
        { width: 1280, height: 720, sampleAspectRatio: "1:1" },
        { width: 640, height: 360, sampleAspectRatio: "1:1" },
        { width: 1280, height: 720, sampleAspectRatio: "1:1" },
    ], "upscale1080p");
    assert.equal(plan.sourceFrameCount, 5);
    assert.equal(plan.droppedSourceFrames, 3);
    assert.equal(plan.selectExpression, "not(between(n\\,0\\,1)+eq(n\\,3))");
    const args = buildUpscaleTranscodeArgs("/source.m3u8", "/output.mp4", plan);
    assert.match(args[args.indexOf("-vf") + 1], /^select=/);
    assert.deepEqual(args.slice(args.indexOf("-fps_mode:v"), args.indexOf("-fps_mode:v") + 2), [
        "-fps_mode:v", "vfr",
    ]);

    assert.throws(() => createUpscalePlan([
        { width: 640, height: 360, sampleAspectRatio: "1:1" },
    ], "upscale1080p"), /no frames with a short edge of at least 720/);
    assert.throws(() => createUpscalePlan([
        { width: 1280, height: 720, sampleAspectRatio: "1:1" },
    ], "upscale1080p", 90), /display-rotation metadata/);
    assert.throws(() => createUpscalePlan([
        { width: 1280, height: 720, sampleAspectRatio: "1:1" },
        { width: 960, height: 720, sampleAspectRatio: "1:1" },
    ], "upscale1080p"), /do not share one display aspect ratio/);
});

test("the XVideos adapter cannot perform network uploads", async () => {
    const uploader = new DisabledXvideosUploader();
    await assert.rejects(() => uploader.upload({
        recordingId: "e".repeat(64),
        artifactPath: "/tmp/artifact.mp4",
        sizeBytes: 1,
        title: "test",
        description: "test",
        tags: ["test"],
        visibility: "private",
    }), /network uploads are disabled/);
});

test("the byte meter refuses a write before it crosses its reservation", () => {
    const meter = new UploadByteMeter(10);
    meter.accountWrittenBytes(4);
    meter.accountWrittenBytes(6);
    assert.equal(meter.transmittedBytes, 10);
    assert.throws(() => meter.accountWrittenBytes(1), /would be exceeded/);
    assert.equal(meter.transmittedBytes, 10);
});

test("a synthetic HLS recording is stream-copied, decoded, probed, and hashed", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-pipeline-remux-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = path.join(root, "source");
    const staging = path.join(root, "staging");
    await mkdir(source);
    const segment = path.join(source, "00001.ts");
    await execFileAsync("ffmpeg", [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
        "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-f", "mpegts", segment,
    ]);
    const playlist = path.join(source, "playlist.m3u8");
    await writeFile(playlist, "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n00001.ts\n#EXT-X-ENDLIST\n");
    const artifactPath = await streamCopyRemux(playlist, staging, "a".repeat(64));
    const validated = await validateArtifact(artifactPath);
    assert.equal(validated.path, artifactPath);
    assert(validated.sizeBytes > 0);
    assert.match(validated.sha256, /^[a-f0-9]{64}$/);
    assert(validated.durationSeconds > 0);
    assert.equal(validated.videoCodec, "h264");
    assert.equal(validated.audioCodec, "aac");
    assert.equal(await streamCopyRemux(playlist, staging, "a".repeat(64)), artifactPath);
});

test("a synthetic 720p HLS recording is transcoded to a validated unpadded 1080p artifact", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-pipeline-upscale-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = path.join(root, "source");
    const staging = path.join(root, "staging");
    await mkdir(source);
    const segment = path.join(source, "00001.ts");
    await execFileAsync("ffmpeg", [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=10",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
        "-t", "0.3", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-f", "mpegts", segment,
    ]);
    const playlist = path.join(source, "playlist.m3u8");
    await writeFile(playlist, "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:0.3,\n00001.ts\n#EXT-X-ENDLIST\n");
    const result = await upscaleTranscode(playlist, staging, "u".repeat(64), "upscale1080p");
    assert.equal(result.plan.outputWidth, 1920);
    assert.equal(result.plan.outputHeight, 1080);
    assert.equal(result.plan.droppedSourceFrames, 0);
    const validated = await validateArtifact(result.path);
    assert.equal(validated.videoWidth, 1920);
    assert.equal(validated.videoHeight, 1080);
    assert.equal(validated.sampleAspectRatio, "1:1");
    assert.equal(validated.displayAspectRatio, "16:9");
    assert.equal(validated.pixelFormat, "yuv420p");
    assert.equal(validated.videoCodec, "h264");
    assert.equal(validated.audioCodec, "aac");
});
