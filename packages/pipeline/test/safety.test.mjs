import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
    containedArtifactPath,
    buildStreamCopyRemuxArgs,
    isDirectArtifactPath,
    streamCopyRemux,
} from "../dist/stages/remux.js";
import {
    buildUpscaleTranscodeArgs,
    createUpscalePlan,
    upscaleTranscode,
    upscaleWholeRecordingTo1080,
} from "../dist/stages/upscale.js";
import {
    analyzeRecordingResolution,
    chooseRecordingResolutionPolicy,
    deriveResolutionPlaylist,
} from "../dist/stages/resolutionPolicy.js";
import { parseRemuxOneArguments } from "../dist/commands/remuxOneArguments.js";
import { validateArtifact } from "../dist/stages/validateArtifact.js";
import { createDefaultStages } from "../dist/stages/defaultStages.js";
import { DisabledXvideosUploader } from "../dist/upload/disabledXvideosUploader.js";
import { UploadByteMeter } from "../dist/upload/uploadCoordinator.js";

const execFileAsync = promisify(execFile);

test("artifact paths are contained and stream-copy remux leaves threading to ffmpeg", () => {
    const id = "d".repeat(64);
    assert.equal(containedArtifactPath("/tmp/staging", id), `/tmp/staging/${id}.mp4`);
    assert.equal(isDirectArtifactPath("/tmp/artifacts/production-v2", `/tmp/artifacts/production-v2/${id}.mp4`), true);
    assert.equal(isDirectArtifactPath("/tmp/artifacts/production-v2", `/tmp/artifacts/legacy-production-v1/${id}.mp4`), false);
    assert.equal(isDirectArtifactPath("/tmp/artifacts/production-v2", `/tmp/artifacts/production-v2/manual/${id}.mp4`), false);
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

test("resolution policy classifies active segment maps by coded short edge", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-resolution-policy-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const playlistPath = path.join(root, "playlist.m3u8");
    await writeFile(playlistPath, [
        "#EXTM3U",
        "#EXT-X-VERSION:7",
        "#EXT-X-TARGETDURATION:2",
        "#EXT-X-MAP:URI=\"unused.mp4\"",
        "#EXT-X-MAP:URI=\"full.mp4\"",
        "#EXTINF:9,",
        "1.ts",
        "#EXT-X-MAP:URI=\"lower.mp4\"",
        "#EXTINF:2,",
        "2.ts",
        "#EXT-X-MAP:URI=\"full-again.mp4\"",
        "#EXTINF:9,",
        "3.ts",
        "#EXT-X-ENDLIST",
        "",
    ].join("\n"));
    const probes = [];
    const dimensions = new Map([
        ["full.mp4", { width: 1920, height: 1080, sampleAspectRatio: "1:1" }],
        ["lower.mp4", { width: 1280, height: 720, sampleAspectRatio: "1:1" }],
        ["full-again.mp4", { width: 1920, height: 1080, sampleAspectRatio: "1:1" }],
    ]);
    const analysis = await analyzeRecordingResolution(playlistPath, async (inputPath) => {
        probes.push(path.basename(inputPath));
        return dimensions.get(path.basename(inputPath));
    });
    assert.deepEqual(probes.sort(), ["full-again.mp4", "full.mp4", "lower.mp4"]);
    assert.equal(analysis.resolutionSummary, "1280x720:1,1920x1080:2");
    const policy = chooseRecordingResolutionPolicy(analysis);
    assert.equal(policy.disposition, "retain1080");
    assert.deepEqual([...policy.maxSegmentIndexes], [0, 2]);

    const derived = deriveResolutionPlaylist(analysis, policy.maxSegmentIndexes);
    assert.match(derived, /#EXT-X-DISCONTINUITY/);
    assert(derived.includes(path.join(root, "1.ts")));
    assert(derived.includes(path.join(root, "3.ts")));
    assert(!derived.includes(path.join(root, "2.ts")));
    assert(!derived.includes("unused.mp4"));
});

test("720p policy includes lower segments when the whole recording is transcoded", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-resolution-720-policy-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const playlistPath = path.join(root, "playlist.m3u8");
    await writeFile(playlistPath, "#EXTM3U\n#EXTINF:1,\nlow.ts\n#EXTINF:1,\nmax.ts\n#EXT-X-ENDLIST\n");
    const analysis = await analyzeRecordingResolution(playlistPath, async (inputPath) => path.basename(inputPath) === "max.ts"
        ? { width: 720, height: 960, sampleAspectRatio: "1:1" }
        : { width: 508, height: 678, sampleAspectRatio: "1:1" });
    const policy = chooseRecordingResolutionPolicy(analysis);
    assert.equal(policy.disposition, "convert1080");
    assert.equal(policy.source.width, 720);
    assert.equal(policy.source.height, 960);
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

test("production 720p upscale converts lower-resolution segments instead of dropping them", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-pipeline-whole-upscale-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = path.join(root, "source");
    const staging = path.join(root, "staging");
    await mkdir(source);
    for (const [name, size] of [["low.ts", "640x360"], ["max.ts", "1280x720"]]) {
        await execFileAsync("ffmpeg", [
            "-nostdin", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=10`,
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
            "-t", "0.4", "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-f", "mpegts", path.join(source, name),
        ]);
    }
    const playlist = path.join(source, "playlist.m3u8");
    await writeFile(playlist, [
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:1",
        "#EXTINF:0.4,",
        "low.ts",
        "#EXT-X-DISCONTINUITY",
        "#EXTINF:0.4,",
        "max.ts",
        "#EXT-X-ENDLIST",
        "",
    ].join("\n"));
    const result = await upscaleWholeRecordingTo1080(playlist, staging, "whole", {
        width: 1280,
        height: 720,
        sampleAspectRatio: "1:1",
    });
    assert.equal(result.plan.selectExpression, null);
    assert.equal(result.plan.droppedSourceFrames, 0);
    const validated = await validateArtifact(result.path);
    assert.equal(validated.videoWidth, 1920);
    assert.equal(validated.videoHeight, 1080);
    assert(validated.durationSeconds > 0.65);
    const lowOnly = await upscaleWholeRecordingTo1080(path.join(source, "low.ts"), staging, "low-only", {
        width: 640, height: 360, sampleAspectRatio: "1:1",
    });
    assert.equal(lowOnly.plan.selectExpression, null);
    assert.equal((await validateArtifact(lowOnly.path)).videoHeight, 1080);
});

test("production mixed 1080p policy produces one whole conversion or one retained remux", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-pipeline-resolution-split-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = path.join(root, "source");
    const staging = path.join(root, "staging");
    await mkdir(source);
    for (const [name, size] of [["full.ts", "1920x1080"], ["lower.ts", "1280x720"]]) {
        await execFileAsync("ffmpeg", [
            "-nostdin", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=10`,
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
            "-t", "0.3", "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-f", "mpegts", path.join(source, name),
        ]);
    }
    const playlistPath = path.join(source, "playlist.m3u8");
    await writeFile(playlistPath, [
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:1",
        "#EXTINF:0.3,",
        "full.ts",
        "#EXT-X-DISCONTINUITY",
        "#EXTINF:0.3,",
        "lower.ts",
        "#EXT-X-ENDLIST",
        "",
    ].join("\n"));
    const recording = {
        id: "mixed",
        provider: "sc",
        sourceKind: "edited",
        sourcePath: source,
        playlistPath,
        sourceFingerprint: "fingerprint",
        durationSeconds: 0.6,
        state: "server_ready",
        blockReason: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        attemptCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    const original = await readFile(playlistPath, "utf8");
    const result = await createDefaultStages(staging).remux(recording);
    assert.equal(result.disposition, "artifact");
    assert.equal(path.basename(result.path), "mixed.production-upscale1080p.mp4");
    const converted = await validateArtifact(result.path);
    assert.equal(converted.videoWidth, 1920);
    assert.equal(converted.videoHeight, 1080);
    assert(converted.durationSeconds >= 0.55);
    assert.equal(await readFile(playlistPath, "utf8"), original);

    const retainedPlaylist = ["#EXTM3U", "#EXT-X-TARGETDURATION:1",
        ...Array.from({ length: 10 }, (_, i) => ["#EXT-X-DISCONTINUITY", "#EXTINF:0.3,", i === 4 ? "lower.ts" : "full.ts"]).flat(),
        "#EXT-X-ENDLIST", ""].join("\n");
    await writeFile(playlistPath, retainedPlaylist);
    const retained = await createDefaultStages(staging).remux({ ...recording, id: "retained", durationSeconds: 3 });
    assert.equal(retained.disposition, "artifact");
    assert.equal(path.basename(retained.path), "retained.retained1080p.mp4");
    const validated = await validateArtifact(retained.path);
    assert.equal(validated.videoHeight, 1080);
    assert(validated.durationSeconds >= 2.6 && validated.durationSeconds < 3);
    assert.equal(await readFile(playlistPath, "utf8"), retainedPlaylist);
    assert.deepEqual((await readdir(staging)).sort(), ["mixed.production-upscale1080p.mp4", "retained.retained1080p.mp4"]);
});

test("mixed threshold uses EXTINF duration, includes exactly 90%, and is orientation neutral", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-resolution-threshold-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const playlist = path.join(root, "playlist.m3u8");
    for (const portrait of [false, true]) {
        for (const [full, low, expected] of [[9, 1, "retain1080"], [8.999, 1.001, "convert1080"], [9.001, 0.999, "retain1080"]]) {
            await writeFile(playlist, `#EXTM3U\n#EXT-X-MAP:URI="full.mp4"\n#EXTINF:${full},\n1.ts\n#EXT-X-MAP:URI="low.mp4"\n#EXTINF:${low},\n2.ts\n#EXT-X-ENDLIST\n`);
            const analysis = await analyzeRecordingResolution(playlist, async (input) => {
                const dimensions = path.basename(input) === "full.mp4" ? [1920, 1080] : [1280, 720];
                if (portrait) dimensions.reverse();
                return { width: dimensions[0], height: dimensions[1], sampleAspectRatio: "1:1" };
            });
            assert.equal(chooseRecordingResolutionPolicy(analysis).disposition, expected);
        }
    }
    for (const extinf of ["", "#EXTINF:0,\n", "#EXTINF:-1,\n", "#EXTINF:bad,\n"]) {
        await writeFile(playlist, `#EXTM3U\n${extinf}1.ts\n#EXT-X-ENDLIST\n`);
        await assert.rejects(() => analyzeRecordingResolution(playlist, async () => ({ width: 1920, height: 1080 })), /duration|EXTINF/);
    }
});
