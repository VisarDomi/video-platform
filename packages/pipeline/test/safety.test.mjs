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
import { validateArtifact } from "../dist/stages/validateArtifact.js";
import { DisabledXvideosUploader } from "../dist/upload/disabledXvideosUploader.js";
import { UploadByteMeter } from "../dist/upload/uploadCoordinator.js";

const execFileAsync = promisify(execFile);

test("artifact paths are contained and stream-copy remux leaves threading to ffmpeg", () => {
    const id = "d".repeat(64);
    assert.equal(containedArtifactPath("/tmp/staging", id), `/tmp/staging/${id}.mp4`);
    assert.throws(() => containedArtifactPath("/tmp/staging", "../escape"), /Invalid recording ID/);
    const args = buildStreamCopyRemuxArgs("/source/playlist.m3u8", "/staging/output.partial");
    assert.deepEqual(args.slice(args.indexOf("-c"), args.indexOf("-c") + 2), ["-c", "copy"]);
    assert(args.includes("-nostdin"));
    assert(!args.includes("-threads"));
    assert(!args.includes("-filter_threads"));
    assert(!args.includes("-filter_complex_threads"));
    assert(!args.includes("-y"));
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
